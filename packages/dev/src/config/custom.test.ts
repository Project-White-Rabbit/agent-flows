import { describe, expect, it } from "vitest"
import { applyPatch, checkConfig, checkPatch, overlay } from "./config.ts"
import { customIntegrations, integrationsFor } from "./custom.ts"
import { coverage, resolveCapability } from "./integrations.ts"
import type { SectionValues } from "./types.ts"

const DEPLOY = {
  name: "Acme Deploy",
  access: { cli: { bin: "acme", auth: ["acme", "whoami"] } },
  provides: {
    deployments: { deployment: { cli: "`acme status {app} --sha <sha>`" } },
  },
  fields: [
    { key: "app", description: "The app's name in Acme", required: true },
  ],
}

function config(entry: object, extra: object = {}): Record<string, unknown> {
  return {
    version: 6,
    repo: { baseBranch: "main" },
    integrations: { "acme-deploy": entry, ...extra },
  }
}

function issuesOf(entry: object): string[] {
  return checkConfig(config(entry)).issues
}

describe("custom integrations", () => {
  it("joins the registry, checked like any integration", () => {
    const c = config({ custom: DEPLOY, app: "web" })
    expect(checkConfig(c)).toEqual({ issues: [], warnings: [] })
    const specs = customIntegrations(c).specs
    expect(specs.map((s) => [s.path, s.name, s.custom])).toEqual([
      ["integrations.acme-deploy", "Acme Deploy", true],
    ])
    expect(integrationsFor(c).at(-1)?.path).toBe("integrations.acme-deploy")
  })

  it("resolves through its capability like a built-in, values filled in", () => {
    const c = config({ custom: DEPLOY, app: "web" })
    const resolved = resolveCapability(c, "deployments")
    expect(resolved.configured).toEqual([
      {
        integration: "acme-deploy",
        name: "Acme Deploy",
        path: "integrations.acme-deploy",
        values: { custom: DEPLOY, app: "web" },
        ops: { deployment: { cli: "`acme status web --sha <sha>`" } },
      },
    ])
    expect(coverage(c).deployments).toEqual(["acme-deploy"])
  })

  it("reads an op of its capability it leaves out as unsupported", () => {
    const c = config({
      custom: {
        name: "Acme Errors",
        provides: {
          errorTracking: { resolveIssue: "Run `acme resolve <issue>`" },
        },
      },
      use: { errorTracking: "resolve" },
    })
    expect(checkConfig(c).issues).toEqual([])
    const [entry] = resolveCapability(c, "errorTracking").configured
    expect(entry.level).toBe("resolve")
    expect(entry.ops).toEqual({
      issueRef: { unsupported: "Acme Errors (custom) doesn't define issueRef" },
      resolveIssue: "Run `acme resolve <issue>`",
    })
  })

  it("fills the API token only into api variants", () => {
    const c = config({
      custom: {
        name: "Acme",
        access: {
          api: { base: "https://acme.dev/api", token: ["ACME_TOKEN"] },
        },
        provides: {
          sessions: {
            shareSession: {
              api: "curl -H 'Authorization: Bearer {token}' https://acme.dev/api/share",
            },
          },
        },
      },
    })
    expect(checkConfig(c).issues).toEqual([])
    const [entry] = resolveCapability(c, "sessions").configured
    expect(entry.ops.shareSession).toEqual({
      api: "curl -H 'Authorization: Bearer $ACME_TOKEN' https://acme.dev/api/share",
    })
  })

  it("rejects an unknown capability, op, or definition key", () => {
    expect(
      issuesOf({
        custom: { ...DEPLOY, provides: { deploys: {} } },
        app: "web",
      }),
    ).toEqual([
      expect.stringMatching(
        /^integrations\.acme-deploy\.custom\.provides\.deploys isn't a capability \(known: sourceControl,/,
      ),
    ])
    expect(
      issuesOf({
        custom: { ...DEPLOY, provides: { deployments: { rollback: "x" } } },
        app: "web",
      }),
    ).toEqual([
      "integrations.acme-deploy.custom.provides.deployments.rollback: deployments has no op `rollback` (its ops: deployment)",
    ])
    expect(
      issuesOf({ custom: { ...DEPLOY, adapters: {} }, app: "web" }),
    ).toEqual([
      "integrations.acme-deploy.custom.adapters isn't part of a custom integration (it takes name, purpose, access, provides, fields)",
    ])
  })

  it("rejects a variant whose access it doesn't declare, and a script variant", () => {
    expect(
      issuesOf({
        custom: {
          ...DEPLOY,
          provides: {
            deployments: {
              deployment: { mcp: "Use acme_status", script: "x" },
            },
          },
        },
        app: "web",
      }),
    ).toEqual([
      "integrations.acme-deploy.custom.provides.deployments.deployment.mcp: the integration declares no `mcp` access, so this variant can't be probed (add it to `access`)",
      "integrations.acme-deploy.custom.provides.deployments.deployment.script: a script variant comes from an adapter in .agent-flows/adapters/<id>.ts, not from the config",
    ])
  })

  it("rejects {token} outside an api variant", () => {
    expect(
      issuesOf({
        custom: {
          ...DEPLOY,
          provides: {
            deployments: { deployment: { cli: "acme status --token {token}" } },
          },
        },
        app: "web",
      }),
    ).toEqual([
      "integrations.acme-deploy.custom.provides.deployments.deployment.cli uses {token}: only an `api` variant may, so the token is read only where it's needed",
    ])
  })

  it("rejects placeholders it can't fill", () => {
    expect(
      issuesOf({
        custom: {
          ...DEPLOY,
          fields: [{ key: "region", description: "Its region" }],
          provides: {
            deployments: { deployment: "`acme status {app} {region} {team}`" },
          },
        },
      }),
    ).toEqual([
      "integrations.acme-deploy.custom.provides.deployments.deployment uses {app}, which is neither a declared field nor a value the entry sets",
      "integrations.acme-deploy.custom.provides.deployments.deployment uses optional {region} with no default: make it required, or write {region|<default>}",
      "integrations.acme-deploy.custom.provides.deployments.deployment uses {team}, which is neither a declared field nor a value the entry sets",
    ])
  })

  it("rejects values that aren't safe in a shell command", () => {
    for (const hostile of ["web;id", "web $(id)", "web`id`", "web'x", "a|b"]) {
      expect(issuesOf({ custom: DEPLOY, app: hostile })).toEqual([
        expect.stringMatching(
          /^integrations\.acme-deploy\.app must be letters, digits/,
        ),
      ])
    }
  })

  it("requires its declared required fields", () => {
    expect(issuesOf({ custom: DEPLOY })).toEqual([
      "integrations.acme-deploy.app is required",
    ])
  })

  it("is configured once, under a well-formed id", () => {
    expect(issuesOf([{ name: "a", custom: DEPLOY, app: "web" }])).toEqual([
      "integrations.acme-deploy: a custom integration is configured once, as an object, not a list of instances",
    ])
    const c = {
      version: 6,
      repo: { baseBranch: "main" },
      integrations: { Acme_CI: { custom: DEPLOY, app: "web" } },
    }
    expect(checkConfig(c).issues).toEqual([
      'integrations.Acme_CI: a custom integration\'s id must start with a lowercase letter and hold only letters, digits, and "-"',
    ])
  })

  it("can't take over a built-in integration's id", () => {
    const c = {
      version: 6,
      repo: { baseBranch: "main" },
      integrations: { vercel: { custom: DEPLOY, app: "web" } },
    }
    expect(customIntegrations(c).specs).toEqual([])
    expect(checkConfig(c).warnings).toContain(
      'unknown field "integrations.vercel.custom" (kept as is; it may come from a newer plugin)',
    )
  })

  it("keeps an exclusive capability exclusive", () => {
    const c = {
      version: 6,
      repo: { baseBranch: "main" },
      integrations: {
        graphite: { trunk: "main" },
        stacker: {
          custom: {
            name: "Stacker",
            access: { cli: { bin: "stk" } },
            provides: { stacking: { parent: { cli: "stk parent" } } },
          },
        },
      },
    }
    expect(checkConfig(c).issues).toEqual([
      "stacking can come from only one integration, but integrations.graphite, integrations.stacker are each used for it: leave it out of the `use` of all but one",
    ])
  })

  it("can be written, removed, and set in a machine's override", () => {
    // A patch is JSON: the definition is an object no built-in field holds.
    const entry = { custom: DEPLOY, app: "web" } as unknown as SectionValues
    expect(
      checkPatch({ sections: { "integrations.acme-deploy": entry } }),
    ).toEqual([])
    expect(
      checkPatch({ sections: { "integrations.acme-deploy": null } }),
    ).toEqual([])
    expect(
      checkPatch({ sections: { "integrations.acme-deploy": { app: "web" } } }),
    ).toEqual([
      expect.stringMatching(/^unknown section "integrations.acme-deploy"/),
    ])
    const written = applyPatch(
      { version: 6, repo: { baseBranch: "main" } },
      { sections: { "integrations.acme-deploy": entry } },
    )
    expect(written.integrations).toEqual({ "acme-deploy": entry })
    const merged = overlay(written, {
      version: 6,
      integrations: { "acme-deploy": { app: "api" } },
    }).config
    // The override's value is laid over the committed entry, not dropped.
    expect(merged.integrations).toEqual({
      "acme-deploy": { custom: DEPLOY, app: "api" },
    })
  })
})

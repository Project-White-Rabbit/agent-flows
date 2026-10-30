import { describe, expect, it } from "vitest"
import { CAPABILITIES } from "../capabilities.ts"
import { checkConfig, exampleConfig } from "../config.ts"
import { toInstanceName, uniqueInstanceNames } from "../instances.ts"
import { OP_PLACEHOLDER, providersOf } from "../integrations.ts"
import type { DetectContext, FieldSpec } from "../types.ts"
import { parseGithubRemote } from "./github.ts"
import { parseGitlabRemote } from "./gitlab.ts"
import { parseGraphiteConfig } from "./graphite.ts"
import { INTEGRATIONS, SECTIONS } from "./index.ts"
import { inferJiraProject, jiraLinkedKeys } from "./jira.ts"
import { inferLinearTeamKey } from "./linear.ts"
import { detectReady, ready } from "./ready.ts"
import { parseSentryConfig } from "./sentry.ts"
import { BITFAB_DEV_FORMAT, sync } from "./sync.ts"
import { ranksFromDoc, ranksProblem, tickets } from "./tickets.ts"

// The contract every section must meet. A new section that breaks the shared
// rules fails here, not in some flow later.
describe("section registry", () => {
  it("has unique, well-formed paths", () => {
    const paths = SECTIONS.map((s) => s.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const path of paths) {
      expect(path).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/)
      expect(["version", "skipped"]).not.toContain(path.split(".")[0])
    }
  })

  it("never nests a section inside another section", () => {
    for (const { path } of SECTIONS) {
      expect(SECTIONS.some((s) => path.startsWith(`${s.path}.`))).toBe(false)
    }
  })

  it.each(SECTIONS.map((s) => [s.path, s] as const))(
    "%s has unique fields whose examples match their types",
    (_path, spec) => {
      const keys = spec.fields.map((f) => f.key)
      expect(new Set(keys).size).toBe(keys.length)
      // Settings that all have defaults (sync's format) may leave every field out.
      if ("provides" in spec || spec.required) {
        expect(spec.fields.some((f) => f.required)).toBe(true)
      }
      for (const field of spec.fields) {
        expect(field.key).toMatch(/^[a-z][a-zA-Z0-9]*$/)
        // Reserved: it names an instance when the section is a list.
        expect(field.key).not.toBe("name")
        expect(typeOf(field.example)).toBe(field.type ?? "string")
      }
    },
  )

  it("accepts a config built from every section's examples", () => {
    expect(checkConfig(exampleConfig())).toEqual({ issues: [], warnings: [] })
  })
})

// What flows rely on when they ask for a capability instead of a vendor.
describe("integration registry", () => {
  it("has unique capability ids, each provided by some integration", () => {
    const ids = CAPABILITIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(providersOf(id).length, id).toBeGreaterThan(0)
    }
  })

  it("gives each leveled capability unique levels and a default among them", () => {
    for (const capability of CAPABILITIES.filter((c) => c.levels)) {
      const ids = capability.levels?.map((l) => l.id) ?? []
      expect(ids.length, capability.id).toBeGreaterThan(1)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toContain(capability.defaultLevel)
    }
  })

  it.each(INTEGRATIONS.map((s) => [s.path, s] as const))(
    "%s lives under integrations and implements every op it provides",
    (path, spec) => {
      expect(path).toMatch(/^integrations\.[a-z][a-zA-Z0-9]*$/)
      expect(Object.keys(spec.provides).length).toBeGreaterThan(0)
      const required = spec.fields.filter((f) => f.required).map((f) => f.key)
      for (const [id, ops] of Object.entries(spec.provides)) {
        const capability = CAPABILITIES.find((c) => c.id === id)
        expect(capability, `unknown capability ${id}`).toBeDefined()
        expect(Object.keys(ops).sort()).toEqual(
          Object.keys(capability?.ops ?? {}).sort(),
        )
        for (const [op, impl] of Object.entries(ops)) {
          const variants: [string, string][] =
            typeof impl === "string" ? [["any", impl]] : Object.entries(impl)
          expect(
            variants.length,
            `${path} ${op} has no variant`,
          ).toBeGreaterThan(0)
          // An unsupported op says why, and nothing else.
          if (typeof impl !== "string" && "unsupported" in impl) {
            expect(variants.length, `${path} ${op}`).toBe(1)
            expect(impl.unsupported.trim(), `${path} ${op}`).not.toBe("")
            continue
          }
          for (const [kind, how] of variants) {
            // A variant needs its access declared, so it can be probed.
            if (kind !== "any") {
              expect(spec.access, `${path} ${op}.${kind}`).toHaveProperty(kind)
            }
            // Only API variants use the token, and only through {token}.
            if (how.includes("{token}")) {
              expect(kind, `${path} ${op} uses {token}`).toBe("api")
            }
            checkPlaceholders(how)
          }
        }
      }

      function checkPlaceholders(how: string): void {
        for (const [, key, fallback] of how.matchAll(OP_PLACEHOLDER)) {
          if (key === "token") {
            continue
          }
          const field = spec.fields.find((f) => f.key === key)
          expect(field, `${path} op uses unknown {${key}}`).toBeDefined()
          // Always set, or given a default for when it isn't.
          if (!fallback) {
            expect(required, `${path} op uses optional {${key}}`).toContain(key)
          }
          // Values land in shell commands from a committed file.
          expect(field?.pattern, `${path}.${key} has no pattern`).toBeDefined()
          for (const hostile of SHELL_HOSTILE) {
            expect(field?.pattern?.regex.test(hostile), hostile).toBe(false)
          }
        }
      }
    },
  )

  it.each(INTEGRATIONS.map((s) => [s.path, s] as const))(
    "%s has adapters only for its ops, reached through access it declares",
    (path, spec) => {
      const ops = Object.values(spec.provides).flatMap((o) => Object.keys(o))
      for (const [op, adapter] of Object.entries(spec.adapters ?? {})) {
        expect(ops, `${path} adapter ${op}`).toContain(op)
        if (adapter.needs) {
          expect(spec.access, `${path} adapter ${op}`).toHaveProperty(
            adapter.needs,
          )
        }
      }
    },
  )

  it.each(INTEGRATIONS.map((s) => [s.path, s] as const))(
    "%s declares at least one way to reach it",
    (_path, spec) => {
      expect(Object.keys(spec.access).length).toBeGreaterThan(0)
      if (spec.access.cli?.auth) {
        expect(spec.access.cli.auth[0]).toBe(spec.access.cli.bin)
      }
      for (const name of spec.access.api?.token ?? []) {
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
      }
    },
  )

  it.each(INTEGRATIONS.map((s) => [s.path, s] as const))(
    "%s opts in only to capabilities it provides, keeping one by default",
    (path, spec) => {
      const provided = Object.keys(spec.provides)
      for (const id of spec.optIn ?? []) {
        expect(provided, `${path} optIn ${id}`).toContain(id)
      }
      expect(provided.some((id) => !spec.optIn?.includes(id))).toBe(true)
    },
  )
})

const SHELL_HOSTILE = [
  "web$(touch x)",
  "web`id`",
  "web;id",
  "web id",
  "web'x",
  'web"x',
  "web|id",
  "web&id",
  "web\nid",
  "web>x",
  "acme/web$(id)",
  "gitlab.acme.dev;id",
]

function typeOf(value: FieldSpec["example"]): string {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return "string[]"
    }
    return value.every((item) => typeof item === "number")
      ? "number[]"
      : "hook[]"
  }
  return typeof value
}

describe("sync format", () => {
  /** A checkout with these tracked files and these files on disk. */
  const checkout = (
    tracked: string[],
    files: Record<string, string> = {},
  ): DetectContext =>
    ({ tracked, read: (file: string) => files[file] }) as DetectContext

  it("proposes bitfab-dev's format where the checkout uses its sync", () => {
    for (const ctx of [
      checkout(["bitfab-internal/bitfab-dev/skills/sync/SKILL.md"]),
      checkout([".gitignore"], {
        ".gitignore": "node_modules\n.bitfab-dev/\n",
      }),
      checkout([], { ".bitfab-dev/state.json": "{}" }),
    ]) {
      expect(sync.detect?.(ctx)?.values).toEqual(BITFAB_DEV_FORMAT)
    }
  })

  it("proposes nothing without a sign of it", () => {
    const ctx = checkout(["src/bitfab-dev.ts", ".gitignore"], {
      ".gitignore": ".bitfab-dev-cache/\n",
    })
    expect(sync.detect?.(ctx)).toBeUndefined()
  })

  it("accepts bitfab-dev's format and rejects values sync can't write", () => {
    const base = { version: 2, repo: { baseBranch: "main" } }
    expect(checkConfig({ ...base, sync: BITFAB_DEV_FORMAT }).issues).toEqual([])
    expect(checkConfig({ ...base, sync: {} }).issues).toEqual([])
    expect(
      checkConfig({
        ...base,
        sync: {
          linkLabels: "vendor",
          errorVerb: "Fixes;",
          prTitle: "{id}: {title}",
          blockMarkers: "no",
        },
      }).issues,
    ).toEqual([
      "sync.linkLabels must be `capability` or `integration`",
      "sync.errorVerb must be a word or a few, letters only (`Fixes`)",
      "sync.prTitle must be text with `{issueId}` and `{title}` placeholders (`{issueId}: {title}`)",
      "sync.blockMarkers must be true or false",
    ])
  })
})

describe("parseGithubRemote", () => {
  it.each([
    "git@github.com:acme/web.git",
    "https://github.com/acme/web",
    "https://github.com/acme/web.git",
    "ssh://git@github.com/acme/web.git",
  ])("parses %s", (url) => {
    expect(parseGithubRemote(url)).toEqual({ owner: "acme", repo: "web" })
  })

  it("ignores other hosts", () => {
    expect(parseGithubRemote("git@gitlab.com:acme/web.git")).toBeUndefined()
  })
})

describe("parseGitlabRemote", () => {
  it.each([
    ["git@gitlab.com:acme/web.git", { project: "acme/web" }],
    ["https://gitlab.com/acme/platform/web", { project: "acme/platform/web" }],
    [
      "ssh://git@gitlab.acme.dev:2222/acme/web.git",
      { project: "acme/web", host: "gitlab.acme.dev" },
    ],
    // An HTTP port is part of the web host; an SSH one isn't.
    [
      "https://gitlab.acme.dev:8443/g/web",
      { project: "g/web", host: "gitlab.acme.dev:8443" },
    ],
    ["https://GitLab.com/g/web", { project: "g/web" }],
    [
      "https://gitlab.com/acme/platform/web.git/",
      { project: "acme/platform/web" },
    ],
    // An SSH alias hides the real host.
    [
      "git@gitlab-work:group/web.git",
      { project: "group/web", alias: "gitlab-work" },
    ],
  ])("parses %s", (url, expected) => {
    expect(parseGitlabRemote(url)).toEqual(expected)
  })

  it.each([
    "git@github.com:acme/web.git",
    // Userinfo that mentions gitlab isn't the host.
    "https://gitlab-ci-token:abc@github.com/acme/web.git",
    "https://gitlab.com/web",
  ])("ignores %s", (url) => {
    expect(parseGitlabRemote(url)).toBeUndefined()
  })
})

describe("inferJiraProject", () => {
  it("picks the most linked site and project", () => {
    expect(
      inferJiraProject([
        "Fixes https://acme.atlassian.net/browse/SUP-12",
        "See acme.atlassian.net/browse/SUP-13 and acme.atlassian.net/browse/OPS-1",
        "No link here",
      ]),
    ).toEqual({ site: "acme.atlassian.net", projectKey: "SUP", hits: 2 })
    expect(inferJiraProject(["ENG-12 without a link"])).toBeUndefined()
    expect(
      inferJiraProject(["acme.atlassian.net/browse/MY_PROJ-12"])?.projectKey,
    ).toBe("MY_PROJ")
  })
})

describe("parseGraphiteConfig", () => {
  it("reads trunk or the first of trunks", () => {
    expect(parseGraphiteConfig('{"trunk":"main"}')).toBe("main")
    expect(parseGraphiteConfig('{"trunks":[{"name":"dev"}]}')).toBe("dev")
    expect(parseGraphiteConfig("not json")).toBeUndefined()
  })
})

describe("inferLinearTeamKey", () => {
  it("ignores keys the team links to Jira", () => {
    expect(
      inferLinearTeamKey(
        ["SUP-1: a", "SUP-2: b", "SUP-3: c"],
        3,
        jiraLinkedKeys(["acme.atlassian.net/browse/SUP-1"]),
      ),
    ).toBeUndefined()
  })

  it("picks the most common ticket prefix, case-insensitively", () => {
    expect(
      inferLinearTeamKey([
        "ruven/eng-12-fix-login",
        "ENG-13: Fix the thing",
        "ENG-14: Another",
        "OPS-1: Rotate keys",
        "Bump UTF-8 handling",
      ]),
    ).toEqual({ key: "ENG", hits: 3 })
  })

  it("needs enough hits to call it a convention", () => {
    expect(inferLinearTeamKey(["ENG-1 once", "ENG-2 twice"])).toBeUndefined()
  })
})

describe("parseSentryConfig", () => {
  it("reads sentry.properties", () => {
    expect(
      parseSentryConfig(
        "defaults.org=acme\ndefaults.project=web\nauth.token=secret",
      ),
    ).toEqual({ org: "acme", project: "web" })
  })

  it("reads .sentryclirc sections", () => {
    expect(
      parseSentryConfig(
        "[auth]\ntoken=secret\n[defaults]\norg=acme\nproject=web\nurl=https://s.acme.dev",
      ),
    ).toEqual({ org: "acme", project: "web", url: "https://s.acme.dev" })
  })
})

describe("instance names", () => {
  it("slugs anything into a valid name", () => {
    expect(toInstanceName("Apps/Web App")).toBe("apps-web-app")
    expect(toInstanceName("a:b")).toBe("a-b")
    expect(toInstanceName("///")).toBe("default")
  })

  it("falls back on collisions, then numbers", () => {
    expect(
      uniqueInstanceNames([
        { preferred: "web", fallback: "apps/web" },
        { preferred: "web", fallback: "packages/web" },
        { preferred: "docs", fallback: "apps/docs" },
        { preferred: "x", fallback: "same" },
        { preferred: "x", fallback: "same" },
      ]),
    ).toEqual(["apps-web", "packages-web", "docs", "same", "same-2"])
    // A suffix never lands on a name that's already used.
    expect(
      uniqueInstanceNames([
        { preferred: "web", fallback: "apps/web" },
        { preferred: "web", fallback: "apps-web" },
        { preferred: "apps-web-2", fallback: "x" },
      ]),
    ).toEqual(["apps-web", "apps-web-2", "apps-web-2-2"])
  })
})

/** A checkout made of `files`, every one tracked; JSON files given as objects. */
function checkout(files: Record<string, unknown>): DetectContext {
  const text = (file: string) => {
    const value = files[file]
    return typeof value === "string" || value === undefined
      ? value
      : JSON.stringify(value)
  }
  const tracked = Object.keys(files)
  const manifests = tracked.filter((f) => f.endsWith("package.json"))
  return {
    tracked,
    packageDirs: [
      "",
      ...manifests
        .filter((f) => f !== "package.json")
        .map((f) => f.slice(0, -"/package.json".length)),
    ],
    read: text,
    readJson: (file: string) =>
      files[file] === undefined ? undefined : JSON.parse(text(file) as string),
    dependsOn: (pattern: RegExp) =>
      manifests.flatMap((file) => {
        const manifest = files[file] as Record<string, object | undefined>
        return Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
        })
          .filter((name) => pattern.test(name))
          .map((name) => `${file} depends on ${name}`)
      }),
  } as DetectContext
}

/** mxpt's scripts: one root package, bun, vitest. */
const MXPT_SCRIPTS = {
  "lint:fix": "biome check --write .",
  format: "biome format --write .",
  lint: "biome check .",
  tsc: "react-router typegen && tsc",
  typecheck: "react-router typegen && tsc",
  knip: "knip",
  test: "vitest run",
  validate:
    "bun run lint:fix && bun run tsc && bun run knip && bun run db:migrate:check",
  "db:migrate:check": "bun scripts/check-migrations.ts",
  "check-all": "bun run validate && bun run test",
}

describe("ready detection", () => {
  it("proposes the validate script, its fix first, and the tests a branch changed", () => {
    // check-all runs the whole suite on top of validate, so it's no candidate.
    expect(
      ready.detect?.(
        checkout({
          "bun.lock": "",
          "package.json": {
            scripts: MXPT_SCRIPTS,
            devDependencies: { vitest: "4" },
          },
        }),
      ),
    ).toEqual({
      values: {
        fix: ["bun run lint:fix"],
        checks: ["bun run validate", "bunx vitest run --changed {base}"],
      },
      evidence: [
        "package.json has a validate script (lint:fix, tsc, knip, db:migrate:check); none of its steps, or the scripts they call, deploy, publish, migrate, or write to a shared service",
        "package.json depends on vitest, and validate runs no tests: ready runs the ones changed since the merge base",
      ],
    })
  })

  // A shared stack package can bring the runner in: the root's own
  // dependencies don't name it, its test scripts and config files do.
  const { test: _test, ...UNTESTED_SCRIPTS } = MXPT_SCRIPTS
  const changedTests = (files: Record<string, unknown>) => {
    const detection = ready.detect?.(checkout({ "bun.lock": "", ...files }))
    return {
      checks: detection?.values.checks,
      evidence: detection?.evidence.at(-1),
    }
  }

  it("finds the runner from the root's test script", () => {
    expect(changedTests({ "package.json": { scripts: MXPT_SCRIPTS } })).toEqual(
      {
        checks: ["bun run validate", "bunx vitest run --changed {base}"],
        evidence:
          "package.json's test script runs vitest, and validate runs no tests: ready runs the ones changed since the merge base",
      },
    )
  })

  it("finds the runner through the scripts a test script calls", () => {
    expect(
      changedTests({
        "package.json": {
          scripts: {
            ...UNTESTED_SCRIPTS,
            test: "bun run test:unit",
            "test:unit": "jest",
          },
        },
      }),
    ).toEqual({
      checks: ["bun run validate", "bunx jest --changedSince={base}"],
      evidence:
        "package.json's test script runs jest, and validate runs no tests: ready runs the ones changed since the merge base",
    })
  })

  it("finds the runner from a tracked config file", () => {
    expect(
      changedTests({
        "package.json": { scripts: UNTESTED_SCRIPTS },
        "vitest.config.ts": "",
      }),
    ).toEqual({
      checks: ["bun run validate", "bunx vitest run --changed {base}"],
      evidence:
        "vitest.config.ts is tracked, and validate runs no tests: ready runs the ones changed since the merge base",
    })
    expect(
      changedTests({
        "package.json": { scripts: UNTESTED_SCRIPTS, jest: {} },
      }).checks,
    ).toEqual(["bun run validate", "bunx jest --changedSince={base}"])
  })

  it("takes the root's dependency over a config file for another runner", () => {
    expect(
      changedTests({
        "package.json": {
          scripts: UNTESTED_SCRIPTS,
          devDependencies: { jest: "30" },
        },
        "vitest.config.ts": "",
      }),
    ).toEqual({
      checks: ["bun run validate", "bunx jest --changedSince={base}"],
      evidence:
        "package.json depends on jest, and validate runs no tests: ready runs the ones changed since the merge base",
    })
  })

  it("guesses no runner when the test script runs both", () => {
    expect(
      changedTests({
        "package.json": {
          scripts: { ...UNTESTED_SCRIPTS, test: "vitest run && jest" },
        },
      }),
    ).toEqual({
      checks: ["bun run validate"],
      evidence:
        "package.json's test script runs vitest and jest, and validate runs no tests: ask which runner's changed tests ready runs, since detection can't tell",
    })
  })

  it("adds no changed tests without a runner, or when the check runs the tests", () => {
    expect(
      changedTests({ "package.json": { scripts: UNTESTED_SCRIPTS } }).checks,
    ).toEqual(["bun run validate"])
    const { validate: _validate, ...scripts } = MXPT_SCRIPTS
    expect(
      changedTests({
        "package.json": { scripts, devDependencies: { vitest: "4" } },
        "vitest.config.ts": "",
      }).checks,
    ).toEqual(["bun run check-all"])
  })

  it("takes a check that runs the tests as it is, with every fix script", () => {
    expect(
      ready.detect?.(
        checkout({
          "package.json": {
            scripts: {
              "lint:fix": "eslint --fix .",
              format: "prettier --write .",
              ci: "npm run lint && jest",
            },
            devDependencies: { jest: "30" },
          },
        }),
      )?.values,
    ).toEqual({
      fix: ["npm run lint:fix", "npm run format"],
      checks: ["npm run ci"],
    })
  })

  it("runs jest's changed tests through the runner, and reads run-s and npm-run-all", () => {
    expect(
      ready.detect?.(
        checkout({
          "pnpm-lock.yaml": "",
          "package.json": {
            scripts: {
              lint: "eslint .",
              "lint:types": "tsc",
              verify: "run-s 'lint:*'",
            },
            devDependencies: { jest: "30" },
          },
        }),
      ),
    ).toEqual({
      values: {
        checks: ["pnpm run verify", "pnpm exec jest --changedSince={base}"],
      },
      evidence: [
        "package.json has a verify script (lint:types); none of its steps, or the scripts they call, deploy, publish, migrate, or write to a shared service",
        "package.json depends on jest, and verify runs no tests: ready runs the ones changed since the merge base",
      ],
    })
  })

  it.each([
    ["deploys", "bun run lint && vercel deploy --prebuilt"],
    ["migrates", "bun run lint && prisma migrate deploy"],
    ["calls a script that migrates", "bun run lint && bun run db:migrate"],
  ])("proposes nothing when the check %s", (_why, validate) => {
    expect(
      detectReady(
        checkout({
          "package.json": {
            scripts: {
              lint: "biome check .",
              "db:migrate": "prisma migrate dev",
              validate,
            },
          },
        }),
      ),
    ).toBeUndefined()
  })

  it("lets a migration check that only reads through", () => {
    expect(
      ready.detect?.(
        checkout({
          "package.json": {
            scripts: { validate: "tsc && prisma migrate diff --exit-code" },
          },
        }),
      )?.values,
    ).toEqual({ checks: ["npm run validate"] })
  })

  it("passes over an unsafe check for a safe one, and says why", () => {
    const detection = ready.detect?.(
      checkout({
        "package.json": {
          scripts: {
            validate: "tsc && vercel deploy",
            ci: "tsc && eslint .",
          },
        },
      }),
    )
    expect(detection?.values).toEqual({ checks: ["npm run ci"] })
    expect(detection?.evidence).toContain(
      "package.json's validate script runs `vercel deploy`, so ready can't run it",
    )
  })

  it("names the other candidates, so configure asks", () => {
    const detection = ready.detect?.(
      checkout({
        "package.json": {
          scripts: { validate: "tsc && eslint .", ci: "tsc && next build" },
        },
      }),
    )
    expect(detection?.values).toEqual({ checks: ["npm run validate"] })
    expect(detection?.evidence.at(-1)).toBe(
      "package.json also has a ci script (tsc, next build); ask which one ready runs",
    )
  })

  it("proposes nothing without a root script that runs the whole check", () => {
    // One tool isn't the whole check, and a package's own scripts are what
    // ready runs per touched package anyway.
    expect(
      detectReady(
        checkout({
          "package.json": {
            scripts: { check: "biome check .", lint: "biome check" },
          },
        }),
      ),
    ).toBeUndefined()
    expect(
      detectReady(
        checkout({
          "package.json": { scripts: { dev: "turbo dev" } },
          "apps/web/package.json": {
            scripts: {
              validate: "tsc && eslint .",
              "lint:fix": "eslint --fix",
            },
          },
          "apps/api/package.json": {
            scripts: { validate: "tsc && vitest run" },
          },
        }),
      ),
    ).toBeUndefined()
  })

  it("reads a monorepo's root check through the packages it filters", () => {
    expect(
      detectReady(
        checkout({
          "bun.lock": "",
          "package.json": {
            scripts: {
              "lint:fix": "biome check --write",
              validate: "bun run lint && bun run --filter @acme/web validate",
            },
          },
          "apps/web/package.json": {
            name: "@acme/web",
            scripts: { validate: "tsc && vitest run" },
          },
          "apps/api/package.json": {
            name: "@acme/api",
            scripts: { validate: "tsc && prisma migrate deploy" },
          },
        }),
      )?.detection,
    ).toEqual({
      values: { fix: ["bun run lint:fix"], checks: ["bun run validate"] },
      evidence: [
        "package.json has a validate script (bun run lint, validate in apps/web); none of its steps, or the scripts they call, deploy, publish, migrate, or write to a shared service",
      ],
    })
  })
})

/** ai-assistant's TASK_PRIORITIZATION.md, cut down to its rank table. */
const PRIORITIZATION = `# Task Prioritization

## Priorities

| Ours | Meaning | Deadline | Linear priority |
|---|---|---|---|
| Urgent | Drop everything and work on it now. | None. It is being worked on right now. | Urgent (1) |
| P0 | Highest planned priority. | Required. Every P0 has a date. | High (2) |
| P1 | Normal priority work. | Optional | Medium (3) |
| P2 | Background work. | Optional | Low (4) |
| Audit | Ongoing work with no finish line. | None | No priority (0) |

## Order of work

| Work | Shape in Linear |
|---|---|
| A piece of work | One task |
`

describe("ticket ranks", () => {
  it("reads the team's rank names off a prioritization doc's table", () => {
    expect(ranksFromDoc(PRIORITIZATION)).toEqual([
      "Urgent",
      "P0",
      "P1",
      "P2",
      "Audit",
    ])
    // Rows in any order, Jira's names, and markdown in the cells.
    expect(
      ranksFromDoc(`| Rank | Jira |
|:--|:--|
| **Sev 2** | High |
| **Sev 1** | Highest |
| Sev 3 | Medium |
| Sev 5 | Lowest |
| Sev 4 | \`Low\` |`),
    ).toEqual(["Sev 1", "Sev 2", "Sev 3", "Sev 4", "Sev 5"])
  })

  it("reads nothing from a table that doesn't map every priority once", () => {
    expect(ranksFromDoc("| Ours | Linear |\n|---|---|\n| P0 | High |")).toBe(
      undefined,
    )
    expect(
      ranksFromDoc(
        "| A | Linear |\n|---|---|\n| a | High |\n| b | High |\n| c | Medium |\n| d | Low |\n| e | None |",
      ),
    ).toBe(undefined)
    expect(ranksFromDoc("No tables here.")).toBe(undefined)
  })

  it("detects the ranks from a tracked prioritization doc", () => {
    expect(
      tickets.detect?.(checkout({ "TASK_PRIORITIZATION.md": PRIORITIZATION })),
    ).toEqual({
      values: { ranks: ["Urgent", "P0", "P1", "P2", "Audit"] },
      evidence: [
        "TASK_PRIORITIZATION.md ranks work as Urgent, P0, P1, P2, Audit, mapped to the tracker's urgent, high, medium, low, none",
      ],
    })
    expect(tickets.detect?.(checkout({ "notes.md": PRIORITIZATION }))).toBe(
      undefined,
    )
    // The tracker's own names are the defaults: nothing to configure.
    const plain =
      "| Ours | Linear |\n|---|---|\n| Urgent | Urgent |\n| High | High |\n| Medium | Medium |\n| Low | Low |\n| No priority | No priority |"
    expect(tickets.detect?.(checkout({ "docs/priorities.md": plain }))).toBe(
      undefined,
    )
  })

  it("takes one distinct name per priority, a priority's own name only in its place", () => {
    expect(ranksProblem(["Urgent", "P0", "P1", "P2", "Audit"])).toBe(undefined)
    expect(ranksProblem(["P0", "P1", "P2", "P3"])).toBe(
      "must name 5 ranks, one each for urgent, high, medium, low, none (got 4)",
    )
    expect(ranksProblem(["P0", "p0", "P1", "P2", "P3"])).toBe(
      "names `p0` twice",
    )
    expect(ranksProblem(["High", "P0", "P1", "P2", "P3"])).toBe(
      "names the `urgent` rank `High`, another priority's name",
    )
    expect(
      checkConfig({
        version: 2,
        repo: { baseBranch: "main" },
        tickets: { ranks: ["P0", "P1"] },
      }).issues,
    ).toEqual([
      "tickets.ranks must name 5 ranks, one each for urgent, high, medium, low, none (got 2)",
    ])
  })
})

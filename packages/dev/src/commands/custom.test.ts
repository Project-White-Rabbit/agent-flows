import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { capabilityContracts } from "./configure.ts"

const DEPLOY = {
  name: "Acme Deploy",
  access: { cli: { bin: "acme-deploy-cli-not-installed" } },
  provides: {
    deployments: {
      deployment: {
        cli: "`acme-deploy-cli-not-installed status {app} --sha <sha>`",
      },
    },
  },
  fields: [{ key: "app", description: "The app's name", required: true }],
}

describe("custom integrations (as scripts)", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const commands = import.meta.dirname
  const node = (script: string, args: string[], input?: string) =>
    spawnSync(process.execPath, [path.join(commands, script), ...args], {
      cwd: dir,
      encoding: "utf8",
      input,
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
    })

  function init(sections: object) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-custom-"))
    execFileSync("git", ["-C", dir, "init", "-q"])
    return node(
      "configure.ts",
      ["write"],
      JSON.stringify({
        sections: { repo: { baseBranch: "main" }, ...sections },
      }),
    )
  }

  it("writes one, and flows get it through its capability", () => {
    const written = init({
      "integrations.acme-deploy": { custom: DEPLOY, app: "web" },
    })
    expect(written.status, written.stdout + written.stderr).toBe(0)
    expect(JSON.parse(written.stdout).coverage.deployments).toEqual([
      "acme-deploy",
    ])

    const result = node("configure.ts", ["integrations", "deployments"])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).integrations.deployments).toEqual([
      {
        integration: "acme-deploy",
        name: "Acme Deploy",
        path: "integrations.acme-deploy",
        values: { custom: DEPLOY, app: "web" },
        access: {
          cli: {
            bin: "acme-deploy-cli-not-installed",
            installed: false,
            ready: false,
          },
        },
        ops: {
          deployment: {
            cli: "`acme-deploy-cli-not-installed status web --sha <sha>`",
          },
        },
      },
    ])

    const get = node("configure.ts", ["get", "integrations.acme-deploy.app"])
    expect(JSON.parse(get.stdout)).toEqual({
      values: { "integrations.acme-deploy.app": "web" },
    })
    const show = node("configure.ts", ["show"])
    expect(JSON.parse(show.stdout).custom).toEqual(["acme-deploy"])
  })

  it("refuses to write one that breaks its capability's contract", () => {
    const result = init({
      "integrations.acme-deploy": {
        custom: { ...DEPLOY, provides: { deployments: { rollback: "x" } } },
        app: "web",
      },
    })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      written: false,
      issues: [
        "integrations.acme-deploy.custom.provides.deployments.rollback: deployments has no op `rollback` (its ops: deployment)",
      ],
    })
  })

  it("runs the repo's adapter for it, listed first", () => {
    init({ "integrations.acme-deploy": { custom: DEPLOY, app: "web" } })
    const file = path.join(
      dir as string,
      ".agent-flows/adapters/acme-deploy.ts",
    )
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      `export const adapters = {
  deployment: {
    args: ["sha"],
    async run({ values, args }) {
      return { state: "success", url: "https://acme.dev/" + values.app + "/" + args.sha, steps: [] }
    },
  },
}
`,
    )
    const listed = JSON.parse(
      node("configure.ts", ["integrations", "deployments"]).stdout,
    )
    expect(
      Object.keys(listed.integrations.deployments[0].ops.deployment),
    ).toEqual(["script", "cli"])
    const result = node("adapter.ts", [
      "run",
      "acme-deploy",
      "deployment",
      "--sha",
      "abc",
    ])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      state: "success",
      url: "https://acme.dev/web/abc",
      steps: [],
    })
  })

  it("prints the contract a custom integration conforms to", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(commands, "configure.ts"), "capabilities", "errorTracking"],
      { encoding: "utf8" },
    )
    expect(result.status, result.stderr).toBe(0)
    const [errors] = JSON.parse(result.stdout).capabilities
    expect(errors).toMatchObject({
      id: "errorTracking",
      ops: { issueRef: expect.any(String), resolveIssue: expect.any(String) },
      levels: [{ id: "link" }, { id: "resolve" }],
      defaultLevel: "link",
      providers: expect.arrayContaining(["sentry"]),
    })
    expect(capabilityContracts().map((c) => c.id)).toContain("sourceControl")
    expect(() => capabilityContracts(["deploys"])).toThrow(
      /unknown capability\(s\): deploys/,
    )
  })
})

import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

describe("adapter.ts (as a script)", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const commands = import.meta.dirname
  const node = (script: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [path.join(commands, script), ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH: process.env.PATH, ...env },
    })

  function init(sections: object): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-adapter-"))
    execFileSync("git", ["-C", dir, "init", "-q"])
    spawnSync(
      process.execPath,
      [path.join(commands, "configure.ts"), "write"],
      {
        cwd: dir,
        input: JSON.stringify({
          sections: { repo: { baseBranch: "main" }, ...sections },
        }),
        encoding: "utf8",
      },
    )
  }

  function repoAdapter(source: string): void {
    const file = path.join(dir as string, ".agent-flows/adapters/linear.ts")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, source)
  }

  it("says when the built-in adapter can't run here", () => {
    init({ "integrations.linear": { teamKey: "ENG" } })
    const result = node(
      "adapter.ts",
      ["run", "linear", "findIssue", "--line", "> Branch: `x`"],
      { LINEAR_API_KEY: "" },
    )
    expect(result.status).toBe(3)
    expect(JSON.parse(result.stdout)).toEqual({
      available: false,
      reason:
        "Linear's adapter needs an API token, and env LINEAR_API_KEY has none. Run the agent-flows configure command to say where the token is on this machine.",
    })
  })

  it("runs the repo's own adapter in place of the built-in one, and lists it first", () => {
    init({
      "integrations.linear": { teamKey: "ENG", use: { issueTracker: "track" } },
    })
    repoAdapter(`export const adapters = {
  findIssue: {
    args: ["line"],
    async run({ values, args }) {
      return { issues: [{ identifier: values.teamKey + "-7", line: args.line }] }
    },
  },
  notAnOp: { async run() { return {} } },
}
`)
    const result = node("adapter.ts", [
      "run",
      "linear",
      "findIssue",
      "--line",
      "> Branch: `x`",
    ])
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      issues: [{ identifier: "ENG-7", line: "> Branch: `x`" }],
    })
    expect(result.stderr).toContain("Linear has no op `notAnOp`")

    const { integrations, warnings } = JSON.parse(
      node("configure.ts", ["integrations", "issueTracker"]).stdout,
    )
    const op = integrations.issueTracker[0].ops.findIssue
    expect(Object.keys(op)).toEqual(["script", "mcp"])
    expect(op.script).toContain("(the repo's adapter)")
    expect(warnings).toEqual([expect.stringContaining("no op `notAnOp`")])
  })

  it("reads the token from where configure recorded it, kept out of the tree", () => {
    init({ "integrations.linear": { teamKey: "ENG" } })
    const key = path.join(
      dir as string,
      "..",
      `key-${path.basename(dir as string)}`,
    )
    fs.writeFileSync(key, "secret\n")
    try {
      const saved = node("configure.ts", ["token", "linear", "--file", key])
      expect(JSON.parse(saved.stdout)).toMatchObject({
        written: true,
        source: `file ${key}`,
      })
      // In the git dir: nothing to commit, and never the token itself.
      expect(
        execFileSync("git", ["-C", dir as string, "status", "--porcelain"], {
          encoding: "utf8",
        }),
      ).not.toContain("local")
      const local = fs.readFileSync(
        path.join(dir as string, ".git/agent-flows/local.json"),
        "utf8",
      )
      expect(local).not.toContain("secret")

      const { integrations } = JSON.parse(
        node("configure.ts", ["integrations", "issueTracker"], {
          LINEAR_API_KEY: "",
        }).stdout,
      )
      expect(integrations.issueTracker[0].access.api).toMatchObject({
        source: `file ${key}`,
        configured: true,
        ready: true,
      })
      expect(integrations.issueTracker[0].ops.getIssue.api).toContain(
        `Authorization: $(cat '${key}')`,
      )

      repoAdapter(`export const adapters = {
  findIssue: {
    needs: "api",
    args: ["line"],
    async run({ token }) { return { gotToken: token === "secret" } },
  },
}
`)
      const run = node(
        "adapter.ts",
        ["run", "linear", "findIssue", "--line", "x"],
        { LINEAR_API_KEY: "" },
      )
      expect(JSON.parse(run.stdout)).toEqual({ gotToken: true })
      expect(run.stdout).not.toContain("secret")
    } finally {
      fs.rmSync(key, { force: true })
    }
  })

  it("refuses an integration that isn't configured, or not used for the op", () => {
    init({ "integrations.github": { owner: "acme", repo: "web" } })
    const missing = node("adapter.ts", [
      "run",
      "linear",
      "findIssue",
      "--line",
      "x",
    ])
    expect(missing.status).toBe(2)
    // Configured, but the team uses it for nothing.
    init({ "integrations.linear": { teamKey: "ENG", use: {} } })
    const unused = node("adapter.ts", [
      "run",
      "linear",
      "findIssue",
      "--line",
      "x",
    ])
    expect(unused.status).toBe(2)
    expect(JSON.parse(unused.stdout).message).toContain(
      "doesn't use Linear for issueTracker",
    )
  })
})

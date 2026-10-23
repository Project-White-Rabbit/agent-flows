import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

describe("configure.ts (as a script)", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const script = path.join(import.meta.dirname, "configure.ts")
  const run = (args: string[], input?: string) =>
    spawnSync("node", [script, ...args], {
      cwd: dir,
      input,
      encoding: "utf8",
    })

  const configFile = () => path.join(dir as string, ".agent-flows/config.json")
  const json = (result: { stdout: string }) => JSON.parse(result.stdout)

  function init(): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-script-"))
    execFileSync("git", ["-C", dir, "init", "-q"])
  }

  it("sends flows to configure when there is no config, and re-runs are no-ops", () => {
    init()
    const missing = run(["get", "repo.baseBranch"])
    expect(missing.status).toBe(2)
    expect(json(missing)).toMatchObject({ configured: false })

    const patch = JSON.stringify({
      sections: {
        repo: { baseBranch: "main" },
        "integrations.github": { owner: "acme", repo: "web" },
      },
      skip: ["integrations.sentry"],
    })
    expect(json(run(["write"], patch)).written).toBe(true)
    const first = fs.readFileSync(configFile(), "utf8")
    expect(json(run(["write"], patch)).written).toBe(false)
    expect(fs.readFileSync(configFile(), "utf8")).toBe(first)

    const got = run(["get", "repo.baseBranch", "integrations.github"])
    expect(got.status).toBe(0)
    expect(json(got)).toEqual({
      values: {
        "repo.baseBranch": "main",
        "integrations.github": { owner: "acme", repo: "web" },
      },
    })
  })

  it("reports missing and skipped paths with the same not-configured exit", () => {
    init()
    run(
      ["write"],
      JSON.stringify({
        sections: { repo: { baseBranch: "main" } },
        skip: ["integrations.linear"],
      }),
    )
    const result = run([
      "get",
      "integrations.linear.teamKey",
      "integrations.sentry",
    ])
    expect(result.status).toBe(2)
    expect(json(result)).toMatchObject({
      configured: false,
      missing: [
        { path: "integrations.linear.teamKey", skipped: true },
        { path: "integrations.sentry" },
      ],
    })
  })

  it("detects and plans only the sections named, even skipped ones", () => {
    init()
    run(
      ["write"],
      JSON.stringify({
        sections: { repo: { baseBranch: "main" } },
        skip: ["integrations.linear"],
      }),
    )
    const result = run(["detect", "linear"])
    expect(result.status).toBe(0)
    const out = json(result)
    expect(out.requested).toEqual(["integrations.linear"])
    expect(out.plan.changes).toEqual([
      expect.objectContaining({ section: "integrations.linear", kind: "add" }),
    ])
    expect(out.plan.needs).toEqual([
      { section: "integrations.linear", fields: ["teamKey"] },
    ])

    const unknown = run(["detect", "bitbucket"])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain("unknown section(s): bitbucket")
  })

  it("expands a capability to every integration that provides it", () => {
    init()
    run(
      ["write"],
      JSON.stringify({ sections: { repo: { baseBranch: "main" } } }),
    )
    const out = json(run(["detect", "issueTracker"]))
    expect(out.requested).toEqual(["integrations.linear", "integrations.jira"])
  })

  it("rejects unknown paths, so a typo in a flow fails loudly", () => {
    init()
    const result = run(["get", "repo.baseBrnch"])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("unknown config path(s): repo.baseBrnch")
  })

  it("keeps sections a newer plugin wrote, and refuses newer formats", () => {
    init()
    fs.mkdirSync(path.dirname(configFile()))
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        version: 2,
        repo: { baseBranch: "main" },
        integrations: { bitbucket: { workspace: "acme" } },
      }),
    )
    const written = json(
      run(
        ["write"],
        JSON.stringify({
          sections: { "integrations.linear": { teamKey: "ENG" } },
        }),
      ),
    )
    expect(written.warnings).toEqual([
      expect.stringContaining('unknown section "integrations.bitbucket"'),
    ])
    expect(
      JSON.parse(fs.readFileSync(configFile(), "utf8")).integrations,
    ).toEqual({
      linear: { teamKey: "ENG" },
      bitbucket: { workspace: "acme" },
    })

    fs.writeFileSync(configFile(), JSON.stringify({ version: 99 }))
    const newer = run(["get", "repo.baseBranch"])
    expect(newer.status).toBe(2)
    expect(json(newer).issues).toEqual([
      expect.stringContaining("upgrade the agent-flows plugin"),
    ])
  })

  it("returns every integration configured for a capability, with filled-in ops", () => {
    init()
    run(
      ["write"],
      JSON.stringify({
        sections: {
          repo: { baseBranch: "main" },
          "integrations.github": { owner: "acme", repo: "web" },
          "integrations.gitlab": { project: "acme/mirror" },
          "integrations.linear": { teamKey: "ENG" },
          "integrations.jira": {
            site: "acme.atlassian.net",
            projectKey: "SUP",
          },
        },
      }),
    )
    const result = run(["integrations", "sourceControl", "issueTracker"])
    expect(result.status).toBe(0)
    const { integrations } = json(result)
    expect(
      integrations.sourceControl.map(
        (i: { integration: string }) => i.integration,
      ),
    ).toEqual(["github", "gitlab"])
    expect(integrations.sourceControl[0].ops.prRef).toContain(
      "https://github.com/acme/web/pull/<N>",
    )
    expect(integrations.sourceControl[1].ops.prRef).toContain(
      "/acme/mirror/-/merge_requests/<N>",
    )
    expect(integrations.issueTracker).toEqual([
      expect.objectContaining({
        integration: "linear",
        values: { teamKey: "ENG" },
      }),
      expect.objectContaining({ integration: "jira" }),
    ])
  })

  it("sends flows to configure for a capability with no integration, unless optional", () => {
    init()
    run(
      ["write"],
      JSON.stringify({
        sections: { repo: { baseBranch: "main" } },
        skip: ["integrations.gitlab"],
      }),
    )
    const result = run(["integrations", "sourceControl"])
    expect(result.status).toBe(2)
    expect(json(result)).toMatchObject({
      configured: false,
      missing: [
        {
          capability: "sourceControl",
          options: ["github"],
          skipped: ["gitlab"],
        },
      ],
    })

    const optional = run(["integrations", "sourceControl", "--optional"])
    expect(optional.status).toBe(0)
    expect(json(optional)).toEqual({ integrations: { sourceControl: [] } })

    const unknown = run(["integrations", "vcs"])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain("unknown capability(s): vcs")
  })

  it("reads a v1 config with services, and rewrites it as integrations", () => {
    init()
    fs.mkdirSync(path.dirname(configFile()))
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        version: 1,
        repo: { baseBranch: "main" },
        services: { github: { owner: "acme", repo: "web" } },
        skipped: ["services.linear"],
      }),
    )
    const got = run(["integrations", "sourceControl"])
    expect(got.status).toBe(0)
    expect(json(got).integrations.sourceControl[0].values).toEqual({
      owner: "acme",
      repo: "web",
    })

    run(
      ["write"],
      JSON.stringify({
        sections: { "integrations.sentry": { org: "acme", project: "web" } },
      }),
    )
    expect(JSON.parse(fs.readFileSync(configFile(), "utf8"))).toEqual({
      version: 2,
      repo: { baseBranch: "main" },
      integrations: {
        github: { owner: "acme", repo: "web" },
        sentry: { org: "acme", project: "web" },
      },
      skipped: ["integrations.linear"],
    })
  })

  it("configures an integration more than once, one entry per instance", () => {
    init()
    const written = json(
      run(
        ["write"],
        JSON.stringify({
          sections: {
            repo: { baseBranch: "main" },
            "integrations.github": [
              { name: "app", owner: "acme", repo: "web" },
              { name: "infra", owner: "acme", repo: "terraform" },
            ],
            "integrations.vercel": [
              { name: "web", project: "prj_web", directory: "apps/web" },
              { name: "docs", project: "prj_docs" },
            ],
          },
        }),
      ),
    )
    expect(written.written).toBe(true)
    expect(written.coverage.sourceControl).toEqual([
      "github:app",
      "github:infra",
    ])

    const { integrations } = json(run(["integrations", "sourceControl"]))
    expect(
      integrations.sourceControl.map(
        (i: { instance: string; ops: { prDiff: string } }) => [
          i.instance,
          i.ops.prDiff,
        ],
      ),
    ).toEqual([
      ["app", "`gh pr diff <N> --repo acme/web`"],
      ["infra", "`gh pr diff <N> --repo acme/terraform`"],
    ])

    expect(json(run(["get", "integrations.vercel.directory"]))).toEqual({
      values: {
        "integrations.vercel.directory": [
          { name: "web", value: "apps/web" },
          { name: "docs", value: null },
        ],
      },
    })

    const graphite = run(
      ["write"],
      JSON.stringify({
        sections: { "integrations.graphite": [{ name: "a", trunk: "main" }] },
      }),
    )
    expect(graphite.status).toBe(1)
    expect(json(graphite).issues).toEqual([
      "integrations.graphite must be an object (it can't be configured more than once)",
    ])
  })

  it("refuses values that would inject into the commands ops build", () => {
    init()
    const result = run(
      ["write"],
      JSON.stringify({
        sections: {
          repo: { baseBranch: "main" },
          "integrations.github": { owner: "acme", repo: "web$(touch pwn)" },
        },
      }),
    )
    expect(result.status).toBe(1)
    expect(json(result).issues).toEqual([
      expect.stringContaining("integrations.github.repo must be letters"),
    ])
  })

  it("builds exact GitLab commands for gitlab.com and self-managed hosts", () => {
    init()
    run(
      ["write"],
      JSON.stringify({
        sections: {
          repo: { baseBranch: "main" },
          "integrations.gitlab": [
            { name: "saas", project: "acme/web" },
            {
              name: "onprem",
              project: "platform/api",
              host: "git.acme.dev:8443",
            },
          ],
        },
      }),
    )
    const [saas, onprem] = json(run(["integrations", "sourceControl"]))
      .integrations.sourceControl
    expect(saas.ops.prDiff).toBe(
      "`glab mr diff <N> -R https://gitlab.com/acme/web --raw`",
    )
    expect(onprem.ops.prDiff).toBe(
      "`glab mr diff <N> -R https://git.acme.dev:8443/platform/api --raw`",
    )
    expect(onprem.ops.prCommits).toContain(
      "projects/platform%2Fapi/merge_requests/<N>/commits --hostname git.acme.dev:8443",
    )
  })
})

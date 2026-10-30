import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { CONFIG_VERSION, serializeConfig } from "../config/config.ts"

describe("configure.ts (as a script)", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const script = path.join(import.meta.dirname, "configure.ts")
  // A PATH holding only git, and no tokens, so access probes see nothing on
  // this machine (CI images ship gh in /usr/bin) unless a test puts it there.
  const onlyGit = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-path-"))
  fs.symlinkSync(
    execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
    path.join(onlyGit, "git"),
  )
  afterAll(() => fs.rmSync(onlyGit, { recursive: true, force: true }))
  const run = (args: string[], input?: string, env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: dir,
      input,
      encoding: "utf8",
      env: { HOME: process.env.HOME, PATH: onlyGit, ...env },
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
      { section: "integrations.linear", fields: ["teamKey", "use"] },
    ])

    const unknown = run(["detect", "bitbucket"])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain("unknown section(s): bitbucket")
  })

  it("reports the mode, and plans every section, skipped ones too, in manual", () => {
    init()
    run(
      ["write"],
      JSON.stringify({
        sections: { repo: { baseBranch: "main" } },
        skip: ["integrations.linear"],
      }),
    )
    // No mode and no names: the flow asks which mode to run.
    const bare = json(run(["detect"]))
    expect(bare.mode).toBeUndefined()
    expect(bare.requested).toBeUndefined()

    const auto = json(run(["detect", "auto"]))
    expect(auto.mode).toBe("auto")
    expect(auto.requested).toBeUndefined()
    expect(auto.plan).toEqual(bare.plan)

    const manual = json(run(["detect", "manual"]))
    expect(manual.mode).toBe("manual")
    expect(manual.requested).toContain("integrations.linear")
    expect(manual.plan.changes).toContainEqual(
      expect.objectContaining({ section: "integrations.linear", kind: "add" }),
    )

    // Names alone are a manual walk of just those sections.
    const named = json(run(["detect", "linear"]))
    expect(named.mode).toBe("manual")
    expect(named.requested).toEqual(["integrations.linear"])
    expect(json(run(["detect", "auto", "linear"])).mode).toBe("auto")

    const both = run(["detect", "auto", "manual"])
    expect(both.status).toBe(1)
    expect(both.stderr).toContain("pick one mode")
  })

  it("expands a capability to every integration that provides it", () => {
    init()
    run(
      ["write"],
      JSON.stringify({ sections: { repo: { baseBranch: "main" } } }),
    )
    const out = json(run(["detect", "issueTracker"]))
    // GitHub too: its issues are opt-in, but asking for the capability offers it.
    const trackers = [
      "integrations.github",
      "integrations.linear",
      "integrations.jira",
    ]
    expect(out.requested).toEqual(trackers)
    // Access is probed for exactly the requested integrations.
    expect(Object.keys(out.access)).toEqual(trackers)
  })

  it("reports how each integration can be reached, to offer the ones in reach", () => {
    init()
    const bin = path.join(dir as string, "bin")
    fs.mkdirSync(bin)
    // A signed-in Vercel CLI: `vercel whoami` exits 0.
    fs.writeFileSync(path.join(bin, "vercel"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    })
    const out = json(
      run(["detect"], undefined, {
        PATH: `${bin}:${onlyGit}`,
        SENTRY_AUTH_TOKEN: "t",
      }),
    )
    expect(out.access["integrations.vercel"].cli).toMatchObject({
      installed: true,
      ready: true,
    })
    expect(out.access["integrations.sentry"].api).toMatchObject({
      source: "env SENTRY_AUTH_TOKEN",
      ready: true,
    })
    expect(out.access["integrations.linear"]).toEqual({
      mcp: { server: "Linear" },
      api: expect.objectContaining({ ready: false }),
    })
    // Being in reach doesn't put it in the plan: configure asks first.
    expect(out.plan.changes.map((c: { section: string }) => c.section)).toEqual(
      ["repo"],
    )
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
      expect.stringContaining("upgrade the dev-flows plugin"),
    ])
  })

  it("repairs an invalid file with a write that fixes it, and only then", () => {
    init()
    fs.mkdirSync(path.dirname(configFile()), { recursive: true })
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        version: 2,
        repo: { baseBranch: "main" },
        ready: { before: [{ name: "bump", run: "x", on: "success" }] },
        merge: { after: "./teardown.sh" },
      }),
    )
    const partial = run(
      ["write"],
      JSON.stringify({
        sections: { ready: { before: [{ name: "bump", run: "x" }] } },
      }),
    )
    expect(partial.status).toBe(1)
    expect(json(partial)).toMatchObject({
      written: false,
      issues: ["merge.after must be a list of hooks"],
    })

    const fixed = run(
      ["write"],
      JSON.stringify({
        sections: {
          ready: { before: [{ name: "bump", run: "x" }] },
          merge: { after: [{ name: "down", run: "./teardown.sh" }] },
        },
      }),
    )
    expect(fixed.status).toBe(0)
    expect(json(fixed).written).toBe(true)
    expect(run(["get", "merge.after"]).status).toBe(0)

    fs.writeFileSync(configFile(), "{ not json")
    const unreadable = run(
      ["write"],
      JSON.stringify({ sections: { repo: { baseBranch: "main" } } }),
    )
    expect(unreadable.status).not.toBe(0)
    expect(unreadable.stderr).toContain("fix it by hand")
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
    // Nothing installed and no tokens: every path but MCP is unavailable.
    expect(integrations.sourceControl[0].access).toEqual({
      mcp: { server: "GitHub" },
      cli: {
        bin: "gh",
        installed: false,
        ready: false,
        auth: "gh auth status",
      },
      api: {
        base: "https://api.github.com",
        source: "env GITHUB_TOKEN",
        configured: false,
        expression: "$GITHUB_TOKEN",
        ready: false,
      },
    })
    const withToken = json(
      run(["integrations", "issueTracker"], undefined, { LINEAR_API_KEY: "k" }),
    ).integrations.issueTracker[0]
    expect(withToken.access.api).toMatchObject({
      source: "env LINEAR_API_KEY",
      ready: true,
    })
    expect(withToken.ops.getIssue.api).toContain(
      "Authorization: $LINEAR_API_KEY",
    )
    expect(JSON.stringify(withToken)).not.toContain('"k"')
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
      version: 3,
      repo: { baseBranch: "main" },
      integrations: {
        github: { owner: "acme", repo: "web" },
        sentry: { org: "acme", project: "web" },
      },
      skipped: ["integrations.linear"],
    })
  })

  it("reads optional values as null, and gives a second account its own token", () => {
    init()
    run(
      ["write"],
      JSON.stringify({
        sections: {
          repo: { baseBranch: "main" },
          tickets: { blockerMark: "🛑", dueDateRequired: ["high"] },
          "integrations.linear": [
            { name: "ours", teamKey: "ENG", use: { issueTracker: "track" } },
            {
              name: "shared",
              teamKey: "OPS",
              mention: "Acme",
              use: { issueTracker: "link" },
            },
          ],
        },
      }),
    )
    const got = run([
      "get",
      "tickets.blockerMark",
      "tickets.planningDoc",
      "--optional",
    ])
    expect(got.status).toBe(0)
    expect(json(got)).toEqual({
      values: { "tickets.blockerMark": "🛑", "tickets.planningDoc": null },
    })
    expect(run(["get", "tickets.planningDoc"]).status).toBe(2)

    expect(json(run(["token", "linear", "--env", "OUR_KEY"])).written).toBe(
      true,
    )
    expect(
      json(run(["token", "linear:shared", "--env", "SHARED_KEY"])).integration,
    ).toBe("linear:shared")
    expect(run(["token", "linear:Bad Name", "--env", "X"]).status).not.toBe(0)
    const { integrations } = json(
      run(["integrations", "issueTracker"], undefined, { SHARED_KEY: "s" }),
    )
    expect(
      integrations.issueTracker.map(
        (i: {
          instance: string
          access: { api: { source: string; ready: boolean } }
        }) => [i.instance, i.access.api.source, i.access.api.ready],
      ),
    ).toEqual([
      ["ours", "env OUR_KEY", false],
      ["shared", "env SHARED_KEY", true],
    ])
  })

  it("refuses a ticket rule outside the tracker's priorities", () => {
    init()
    const result = run(
      ["write"],
      JSON.stringify({
        sections: {
          repo: { baseBranch: "main" },
          tickets: { dueDateRequired: ["P0"] },
        },
      }),
    )
    expect(result.status).toBe(1)
    expect(json(result).issues).toEqual([
      "tickets.dueDateRequired must list only `urgent`, `high`, `medium`, `low`, or `none` (not `P0`)",
    ])
  })

  it("sets an estimate scale, and refuses one that isn't numbers smallest first", () => {
    init()
    const written = run(
      ["write"],
      JSON.stringify({
        sections: {
          repo: { baseBranch: "main" },
          tickets: { estimateScale: [1, 2, 4, 8] },
        },
      }),
    )
    expect(written.status).toBe(0)
    expect(json(run(["get", "tickets.estimateScale"]))).toEqual({
      values: { "tickets.estimateScale": [1, 2, 4, 8] },
    })

    const words = run(
      ["write"],
      JSON.stringify({ sections: { tickets: { estimateScale: ["S", "M"] } } }),
    )
    expect(words.status).toBe(1)
    expect(json(words).issues).toEqual([
      "tickets.estimateScale must be a non-empty list of numbers, 0 or more",
    ])
    const unsorted = run(
      ["write"],
      JSON.stringify({ sections: { tickets: { estimateScale: [4, 2, 2] } } }),
    )
    expect(unsorted.status).toBe(1)
    expect(json(unsorted).issues).toEqual([
      "tickets.estimateScale must list its numbers smallest first, without repeats",
    ])
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
        (i: { instance: string; ops: { prDiff: { cli: string } } }) => [
          i.instance,
          i.ops.prDiff.cli,
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

  it("records what each integration is used for, and resolves only that", () => {
    init()
    const write = (sections: object) =>
      run(["write"], JSON.stringify({ sections }))
    const bad = write({
      repo: { baseBranch: "main" },
      "integrations.linear": {
        teamKey: "ENG",
        use: { issueTracker: "everything", chat: true },
      },
    })
    expect(bad.status).toBe(1)
    expect(json(bad).issues).toEqual([
      'integrations.linear.use.issueTracker must be one of "link", "track"',
      "integrations.linear.use.chat: Linear doesn't provide chat (it provides issueTracker)",
    ])

    expect(
      json(
        write({
          repo: { baseBranch: "main" },
          "integrations.github": { owner: "acme", repo: "web" },
          "integrations.linear": {
            teamKey: "ENG",
            project: "Web app",
            use: { issueTracker: "track" },
          },
          "integrations.posthog": {
            projectId: "1",
            use: { featureFlags: true },
          },
        }),
      ).written,
    ).toBe(true)
    const { integrations } = json(
      run([
        "integrations",
        "sourceControl",
        "issueTracker",
        "analytics",
        "featureFlags",
        "--optional",
      ]),
    )
    // No `use`: the capability's default level, except GitHub's opt-in issues.
    expect(integrations.sourceControl[0]).toMatchObject({ level: "write" })
    expect(
      integrations.issueTracker.map(
        (i: { integration: string }) => i.integration,
      ),
    ).toEqual(["linear"])
    expect(integrations.issueTracker[0]).toMatchObject({
      level: "track",
      values: { teamKey: "ENG", project: "Web app" },
    })
    expect(integrations.issueTracker[0].values).not.toHaveProperty("use")
    expect(integrations.issueTracker[0].ops.createIssue.mcp).toContain(
      "`parentId: <parent>` when given",
    )
    // PostHog is only used for feature flags here.
    expect(integrations.analytics).toEqual([])
    expect(integrations.featureFlags).toEqual([
      expect.not.objectContaining({ level: expect.anything() }),
    ])
    // The plan asks for the use github doesn't state yet.
    expect(json(run(["detect", "github"])).plan.needs).toEqual([
      { section: "integrations.github", fields: ["use"] },
    ])

    // Named in `use`, GitHub tracks issues too, after Linear's entry.
    write({
      repo: { baseBranch: "main" },
      "integrations.github": {
        owner: "acme",
        repo: "web",
        use: { sourceControl: "write", issueTracker: "track" },
      },
    })
    const tracked = json(run(["integrations", "issueTracker"])).integrations
      .issueTracker
    expect(
      tracked.map((i: { integration: string; level: string }) => [
        i.integration,
        i.level,
      ]),
    ).toEqual([
      ["github", "track"],
      ["linear", "track"],
    ])
    expect(tracked[0].ops.updateIssue.cli).toContain(
      "`gh issue edit <N> --repo acme/web",
    )
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
    expect(saas.ops.prDiff.cli).toBe(
      "`glab mr diff <N> -R https://gitlab.com/acme/web --raw`",
    )
    expect(onprem.ops.prDiff.cli).toBe(
      "`glab mr diff <N> -R https://git.acme.dev:8443/platform/api --raw`",
    )
    expect(onprem.ops.prCommits.cli).toContain(
      "projects/platform%2Fapi/merge_requests/<N>/commits --hostname git.acme.dev:8443",
    )
  })

  it("layers this machine's override over the committed config, without touching it", () => {
    init()
    const localFile = path.join(dir as string, ".git/agent-flows/config.json")
    run(
      ["write"],
      JSON.stringify({
        sections: {
          repo: { baseBranch: "main" },
          "integrations.github": { owner: "acme", repo: "web" },
        },
        skip: ["integrations.linear"],
      }),
    )
    const committed = fs.readFileSync(configFile(), "utf8")

    const written = run(
      ["write", "--local"],
      JSON.stringify({
        sections: {
          repo: { baseBranch: "develop" },
          "integrations.linear": {
            teamKey: "ME",
            use: { issueTracker: "track" },
          },
        },
        skip: ["integrations.github"],
      }),
    )
    expect(written.status).toBe(0)
    expect(json(written)).toMatchObject({
      configPath: fs.realpathSync(localFile),
      local: true,
      written: true,
    })
    expect(fs.readFileSync(configFile(), "utf8")).toBe(committed)

    const got = json(
      run(["get", "repo.baseBranch", "integrations.linear.teamKey"]),
    )
    expect(got.values).toEqual({
      "repo.baseBranch": "develop",
      "integrations.linear.teamKey": "ME",
    })
    expect(run(["get", "integrations.github"]).status).toBe(2)
    expect(json(run(["show"])).overridden).toEqual([
      "repo",
      "integrations.linear",
      "integrations.github",
    ])

    // null drops a section from the override, so the committed one is back.
    run(["write", "--local"], JSON.stringify({ sections: { repo: null } }))
    expect(json(run(["get", "repo.baseBranch"])).values).toEqual({
      "repo.baseBranch": "main",
    })

    // The override must make a valid config on top of the committed one.
    const invalid = run(
      ["write", "--local"],
      JSON.stringify({ skip: ["repo"] }),
    )
    expect(invalid.status).toBe(1)
    expect(json(invalid).written).toBe(false)
  })

  it("configures a repo that has no committed config, from the override alone", () => {
    init()
    const written = run(
      ["write", "--local"],
      JSON.stringify({ sections: { repo: { baseBranch: "trunk" } } }),
    )
    expect(written.status).toBe(0)
    expect(fs.existsSync(configFile())).toBe(false)
    expect(json(run(["get", "repo.baseBranch"])).values).toEqual({
      "repo.baseBranch": "trunk",
    })
    expect(json(run(["detect", "local", "linear"]))).toMatchObject({
      mode: "manual",
      local: true,
      requested: ["integrations.linear"],
    })
  })

  it("replaces the committed config instead, starting from what it read as", () => {
    init()
    const localFile = path.join(dir as string, ".git/agent-flows/config.json")
    run(
      ["write"],
      JSON.stringify({
        sections: {
          repo: { baseBranch: "main" },
          "integrations.github": { owner: "acme", repo: "web" },
        },
      }),
    )
    run(
      ["write", "--local"],
      JSON.stringify({ sections: { repo: { baseBranch: "develop" } } }),
    )

    // Switching to replace copies the config as it reads now.
    const switched = run(["write", "--local", "--replace"], "{}")
    expect(switched.status).toBe(0)
    const file = JSON.parse(fs.readFileSync(localFile, "utf8"))
    expect(file).toMatchObject({
      version: 3,
      override: "replace",
      repo: { baseBranch: "develop" },
      integrations: { github: { owner: "acme", repo: "web" } },
    })
    expect(Object.keys(file).slice(0, 2)).toEqual(["version", "override"])

    // The committed file no longer reaches this machine.
    run(
      ["write"],
      JSON.stringify({
        sections: { "integrations.github": { owner: "acme", repo: "api" } },
      }),
    )
    const shown = json(run(["show"]))
    expect(shown.override).toBe("replace")
    expect(shown.overridden).toBeUndefined()
    expect(shown.config.integrations.github.repo).toBe("web")

    // Later local writes stay in replace without saying so again.
    run(
      ["write", "--local"],
      JSON.stringify({ sections: { "integrations.github": null } }),
    )
    expect(run(["get", "integrations.github"]).status).toBe(2)
    expect(JSON.parse(fs.readFileSync(localFile, "utf8")).override).toBe(
      "replace",
    )

    // Merge again: the override's sections layer over the committed file.
    run(["write", "--local", "--merge"], "")
    expect(JSON.parse(fs.readFileSync(localFile, "utf8")).override).toBe(
      undefined,
    )
    expect(json(run(["get", "integrations.github.repo"])).values).toEqual({
      "integrations.github.repo": "api",
    })

    expect(json(run(["detect", "replace"]))).toMatchObject({
      local: true,
      replace: true,
    })
    expect(run(["write", "--replace"], "{}").status).toBe(1)
  })

  it("refuses an override that doesn't say merge or replace", () => {
    init()
    fs.mkdirSync(path.join(dir as string, ".git/agent-flows"))
    fs.writeFileSync(
      path.join(dir as string, ".git/agent-flows/config.json"),
      JSON.stringify({
        version: 2,
        override: "both",
        repo: { baseBranch: "main" },
      }),
    )
    const got = run(["get", "repo.baseBranch"])
    expect(got.status).toBe(2)
    expect(json(got).issues[0]).toContain(
      'override must be "merge" or "replace"',
    )
  })

  describe("write keeps the repo's format", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../../..")
    const realBiome = path.join(repoRoot, "node_modules", ".bin", "biome")
    const patch = JSON.stringify({
      sections: {
        repo: { baseBranch: "main" },
        "integrations.github": { owner: "acme", repo: "web" },
      },
      skip: ["integrations.sentry", "integrations.linear"],
    })
    // The same config, the way Biome lays it out: short arrays on one line.
    const collapsed = `{
  "version": ${CONFIG_VERSION},
  "repo": {
    "baseBranch": "main"
  },
  "integrations": {
    "github": {
      "owner": "acme",
      "repo": "web"
    }
  },
  "skipped": ["integrations.linear", "integrations.sentry"]
}
`
    const file = (name: string) => path.join(dir as string, name)
    const read = () => fs.readFileSync(configFile(), "utf8")
    const put = (content: string) => {
      fs.mkdirSync(path.dirname(configFile()), { recursive: true })
      fs.writeFileSync(configFile(), content)
    }
    // A formatter binary that records its arguments, writes $STUB_OUTPUT over
    // the file it's given (when set), and exits $STUB_EXIT.
    function stub(name: string): void {
      const bin = file(`node_modules/.bin/${name}`)
      fs.mkdirSync(path.dirname(bin), { recursive: true })
      fs.writeFileSync(
        bin,
        `#!/bin/sh
printf '%s\\n' "$@" > "${file("args")}"
for last; do :; done
[ -n "$STUB_OUTPUT" ] && printf '%s' "$STUB_OUTPUT" > "$last"
exit "\${STUB_EXIT:-0}"
`,
        { mode: 0o755 },
      )
    }
    const ran = () => fs.existsSync(file("args"))

    it("leaves a formatted file with the same content alone, without formatting it", () => {
      init()
      fs.writeFileSync(file("biome.json"), "{}")
      stub("biome")
      put(collapsed)
      const out = json(run(["write"], JSON.stringify({ skip: [] })))
      expect(out.written).toBe(false)
      expect(out.formatted).toBeUndefined()
      expect(read()).toBe(collapsed)
      expect(ran()).toBe(false)
      expect(json(run(["write"], patch)).written).toBe(false)
      expect(read()).toBe(collapsed)
    })

    it("leaves a hand-reordered file with the same content alone", () => {
      init()
      const reordered = `{"skipped": ["integrations.linear", "integrations.sentry"], "integrations": {"github": {"repo": "web", "owner": "acme"}}, "repo": {"baseBranch": "main"}, "version": ${CONFIG_VERSION}}`
      put(reordered)
      expect(json(run(["write"], patch)).written).toBe(false)
      expect(read()).toBe(reordered)
    })

    it("writes the plain layout when the repo has no formatter, or it isn't installed", () => {
      init()
      const plain = json(run(["write"], patch))
      expect(plain).toMatchObject({
        written: true,
        formatted: false,
        formatReason: "no formatter configured",
      })
      expect(read()).toBe(serializeConfig(plain.config))

      fs.rmSync(configFile())
      fs.writeFileSync(file("biome.json"), "{}")
      expect(json(run(["write"], patch))).toMatchObject({
        written: true,
        formatted: false,
        formatReason: "biome not installed",
      })
      expect(read()).toBe(serializeConfig(plain.config))
    })

    it("formats only the config file with the repo's formatter after a real change", () => {
      init()
      fs.writeFileSync(file("biome.json"), "{}")
      stub("biome")
      const out = json(run(["write"], patch, { STUB_OUTPUT: collapsed }))
      expect(out).toMatchObject({ written: true, formatted: "biome" })
      expect(out.formatReason).toBeUndefined()
      expect(fs.readFileSync(file("args"), "utf8")).toBe(
        "format\n--write\n--no-errors-on-unmatched\n.agent-flows/config.json\n",
      )
      expect(read()).toBe(collapsed)
    })

    it("keeps the plain layout when the formatter fails or changes the content", () => {
      init()
      fs.writeFileSync(file("biome.json"), "{}")
      stub("biome")
      const failed = run(["write"], patch, { STUB_EXIT: "1" })
      expect(failed.status).toBe(0)
      const out = json(failed)
      expect(out).toMatchObject({
        written: true,
        formatted: false,
        formatReason: "biome exited 1",
      })
      expect(read()).toBe(serializeConfig(out.config))

      fs.rmSync(configFile())
      expect(
        json(run(["write"], patch, { STUB_OUTPUT: '{"version": 1}\n' })),
      ).toMatchObject({
        written: true,
        formatted: false,
        formatReason: "biome changed the config's content",
      })
      expect(read()).toBe(serializeConfig(out.config))
    })

    it("uses Prettier when that's what the repo configures, and Biome when it has both", () => {
      init()
      fs.writeFileSync(file(".prettierrc"), "{}")
      stub("prettier")
      expect(json(run(["write"], patch))).toMatchObject({
        formatted: "prettier",
      })
      expect(fs.readFileSync(file("args"), "utf8")).toBe(
        "--write\n.agent-flows/config.json\n",
      )

      fs.rmSync(configFile())
      fs.writeFileSync(file("biome.json"), "{}")
      stub("biome")
      expect(json(run(["write"], patch))).toMatchObject({ formatted: "biome" })
    })

    it.skipIf(!fs.existsSync(realBiome))(
      "round-trips through the real Biome",
      () => {
        init()
        fs.writeFileSync(
          file("biome.json"),
          '{"formatter": {"indentStyle": "space"}}',
        )
        fs.mkdirSync(file("node_modules/.bin"), { recursive: true })
        fs.symlinkSync(realBiome, file("node_modules/.bin/biome"))
        // Biome's launcher is a node script.
        const env = {
          PATH: `${onlyGit}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        }
        expect(json(run(["write"], patch, env))).toMatchObject({
          written: true,
          formatted: "biome",
        })
        expect(read()).toBe(collapsed)
        expect(json(run(["write"], patch, env)).written).toBe(false)
        expect(read()).toBe(collapsed)
      },
    )
  })
})

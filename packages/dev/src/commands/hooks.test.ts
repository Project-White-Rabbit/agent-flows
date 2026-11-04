import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { HookPoint } from "../config/hooks.ts"
import type { Hook } from "../config/types.ts"
import {
  checkFlags,
  type HookRequest,
  parsePoints,
  runHooks,
  tryHook,
} from "./hooks.ts"

const dirs: string[] = []

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

/** A repo on `main` with one commit, then a branch that changed `files`. */
function repo(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-"))
  dirs.push(root)
  git(root, "init", "--quiet", "--initial-branch", "main")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  git(root, "commit", "--quiet", "--allow-empty", "-m", "base")
  git(root, "checkout", "--quiet", "-b", "feature")
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function config(sections: Record<string, Record<string, Hook[]>>) {
  return { version: 2, repo: { baseBranch: "main" }, ...sections }
}

function request(
  points: string[],
  flow: string,
  rest: Partial<HookRequest> = {},
): HookRequest {
  return { points: parsePoints(points, flow), flow, ...rest }
}

describe("runHooks", () => {
  it("runs commands in order with the point's values, and passes on exit 0", () => {
    const root = repo({ "src/a.ts": "" })
    const report = runHooks(
      root,
      config({
        ready: {
          before: [
            {
              name: "vars",
              run: 'echo "$AGENT_FLOWS_FLOW $AGENT_FLOWS_MODE {branch}" > out.txt; cat "$AGENT_FLOWS_CHANGED_FILES" >> out.txt',
            },
          ],
        },
      }),
      request(["ready.before"], "ready", { mode: "loop" }),
    )
    expect(report).toMatchObject({
      status: "done",
      ran: [{ point: "ready.before", name: "vars", result: "passed" }],
      failures: [],
    })
    expect(fs.readFileSync(path.join(root, "out.txt"), "utf8")).toBe(
      "ready loop feature\nsrc/a.ts\n",
    )
  })

  it("runs a fix once and checks again", () => {
    const root = repo()
    const report = runHooks(
      root,
      config({
        ready: {
          before: [
            { name: "bump", run: "test -f bumped", fix: "touch bumped" },
          ],
        },
      }),
      request(["ready.before"], "ready"),
    )
    expect(report.status).toBe("done")
    expect(report.ran[0]?.result).toBe("fixed")
  })

  it("stops at a failure that survives its fix, before the hooks after it", () => {
    const root = repo()
    const report = runHooks(
      root,
      config({
        ready: {
          before: [
            { name: "bad", run: "echo nope; exit 1", fix: "true" },
            { name: "never", run: "touch ran" },
          ],
        },
      }),
      request(["ready.before"], "ready"),
    )
    expect(report.status).toBe("stop")
    expect(report.stop).toMatchObject({
      name: "bad",
      result: "failed",
      output: "nope",
    })
    expect(fs.existsSync(path.join(root, "ran"))).toBe(false)
    expect(fs.readFileSync(report.stop?.log as string, "utf8")).toContain(
      "$ fix: true",
    )
  })

  it("reports failures at an after point and runs the rest", () => {
    const root = repo()
    const report = runHooks(
      root,
      config({
        merge: { after: [{ name: "down", run: "exit 3" }] },
        hooks: { after: [{ name: "notify", run: "touch notified" }] },
      }),
      request(["merge.after", "after"], "merge", { outcome: "success" }),
    )
    expect(report.status).toBe("done")
    expect(report.failures.map((f) => f.name)).toEqual(["down"])
    expect(fs.existsSync(path.join(root, "notified"))).toBe(true)
  })

  it("hands exit 2's stderr to the agent, and resumes after it", () => {
    const root = repo()
    const hooks = config({
      ready: {
        before: [
          { name: "docs", run: "echo 'Update docs/sdk.md' >&2; exit 2" },
          { name: "next", run: "touch next" },
        ],
      },
    })
    const first = runHooks(root, hooks, request(["ready.before"], "ready"))
    expect(first).toMatchObject({
      status: "agent",
      agent: {
        name: "docs",
        task: "Update docs/sdk.md",
        resume: "ready.before/docs",
      },
    })
    expect(fs.existsSync(path.join(root, "next"))).toBe(false)
    const second = runHooks(
      root,
      hooks,
      request(["ready.before"], "ready", { after: first.agent?.resume }),
    )
    expect(second.status).toBe("done")
    expect(second.ran.map((r) => r.name)).toEqual(["next"])
  })

  it("hands a prompt to the agent with its placeholders filled", () => {
    const root = repo()
    const report = runHooks(
      root,
      config({
        hooks: {
          after: [
            { name: "tell", prompt: "It ended in {outcome} on {branch}" },
          ],
        },
      }),
      request(["after"], "sync", { outcome: "failure" }),
    )
    expect(report.agent?.task).toBe("It ended in failure on feature")
  })

  it("skips hooks whose paths, modes, or outcome don't match, and says why", () => {
    const root = repo({ "src/a.ts": "" })
    const report = runHooks(
      root,
      config({
        ready: {
          after: [
            { name: "docs", paths: ["docs/**"], run: "true" },
            { name: "src", paths: ["src/*.ts"], run: "true" },
            { name: "draft", modes: ["draft"], run: "true" },
            { name: "won", on: "success", run: "true" },
          ],
        },
      }),
      request(["ready.after"], "ready", {
        mode: "default",
        outcome: "failure",
      }),
    )
    expect(report.ran.map((r) => [r.name, r.result, r.reason])).toEqual([
      ["docs", "skipped", "no changed file matches docs/**"],
      ["src", "passed", undefined],
      ["draft", "skipped", "only in draft mode"],
      ["won", "skipped", "only on success"],
    ])
  })

  it("fails a command that runs past its timeout, without trying its fix, and kills what it started", () => {
    const root = repo()
    const report = runHooks(
      root,
      config({
        ready: {
          before: [
            {
              name: "slow",
              run: "(sleep 2; touch late) & sleep 5",
              fix: "touch fixed",
              timeout: 1,
            },
          ],
        },
      }),
      request(["ready.before"], "ready"),
    )
    expect(report.stop?.result).toBe("timedOut")
    expect(fs.existsSync(path.join(root, "fixed"))).toBe(false)
    spawnSync("sleep", ["1.5"])
    expect(fs.existsSync(path.join(root, "late"))).toBe(false)
  })

  it("passes what each flow knows: the issue, the result, the merge, and the evaluation it follows", () => {
    const root = repo()
    const env =
      'echo "$AGENT_FLOWS_PR|$AGENT_FLOWS_ISSUE|$AGENT_FLOWS_ISSUE_FILED|$AGENT_FLOWS_RESULT|$AGENT_FLOWS_MERGED|$AGENT_FLOWS_MERGE_COMMIT|$AGENT_FLOWS_SINCE|$AGENT_FLOWS_SCOPE" > out.txt'
    runHooks(
      root,
      config({ hooks: { after: [{ name: "vars", run: env }] } }),
      request(["after"], "sync", {
        outcome: "success",
        pr: "7",
        issue: "ENG-1",
        issueFiled: true,
        result: "full",
      }),
    )
    expect(fs.readFileSync(path.join(root, "out.txt"), "utf8")).toBe(
      "7|ENG-1|1|full||||\n",
    )
    runHooks(
      root,
      config({
        merge: {
          after: [{ name: "vars", run: `${env}; echo {merge} >> out.txt` }],
        },
      }),
      request(["merge.after"], "merge", {
        outcome: "failure",
        merged: true,
        mergeCommit: "abc123",
      }),
    )
    expect(fs.readFileSync(path.join(root, "out.txt"), "utf8")).toBe(
      "||||1|abc123||\nabc123\n",
    )
    runHooks(
      root,
      config({ evaluate: { scan: [{ name: "vars", run: env }] } }),
      request(["evaluate.scan"], "evaluate", {
        pr: "9",
        since: "def456",
        scope: "delta",
      }),
    )
    expect(fs.readFileSync(path.join(root, "out.txt"), "utf8")).toBe(
      "9||||||def456|delta\n",
    )
  })

  it("runs a general hook only around its flows, and in their modes", () => {
    const root = repo()
    const hooks = config({
      hooks: {
        before: [
          { name: "ship", flows: ["sync", "ready", "merge"], run: "true" },
          { name: "local", flows: ["sync"], modes: ["local"], run: "true" },
        ],
      },
    })
    expect(
      runHooks(root, hooks, request(["before"], "evaluate")).ran.map((r) => [
        r.name,
        r.result,
        r.reason,
      ]),
    ).toEqual([
      ["ship", "skipped", "only around sync, ready, merge"],
      ["local", "skipped", "only around sync"],
    ])
    expect(
      runHooks(
        root,
        hooks,
        request(["before"], "sync", { mode: "local" }),
      ).ran.map((r) => r.result),
    ).toEqual(["passed", "passed"])
  })

  it("runs an on: merged hook whenever the pull request merged, whatever the outcome", () => {
    const root = repo()
    const hooks = config({
      merge: {
        after: [
          { name: "release", on: "merged", run: "true" },
          { name: "won", on: "success", run: "true" },
        ],
      },
    })
    expect(
      runHooks(
        root,
        hooks,
        request(["merge.after"], "merge", { outcome: "failure", merged: true }),
      ).ran.map((r) => [r.name, r.result]),
    ).toEqual([
      ["release", "passed"],
      ["won", "skipped"],
    ])
    expect(
      runHooks(
        root,
        hooks,
        request(["merge.after"], "merge", { outcome: "failure" }),
      ).ran[0],
    ).toMatchObject({
      result: "skipped",
      reason: "only when the pull request merged",
    })
  })

  it("runs a recheck hook's command again after its task, and stops when it still fails", () => {
    const root = repo()
    const hooks = config({
      ready: {
        before: [
          {
            name: "docs",
            run: "test -f docs.md || { echo 'Write docs.md' >&2; exit 2; }",
            recheck: true,
          },
          { name: "next", run: "touch next" },
        ],
      },
    })
    const first = runHooks(root, hooks, request(["ready.before"], "ready"))
    expect(first.agent).toMatchObject({
      task: "Write docs.md",
      resume: "ready.before/docs",
      recheck: true,
    })

    // The task wasn't done: the recheck stops, and the rest don't run.
    const undone = runHooks(
      root,
      hooks,
      request(["ready.before"], "ready", { after: "ready.before/docs" }),
    )
    expect(undone.status).toBe("stop")
    expect(undone.stop).toMatchObject({
      name: "docs",
      result: "failed",
      recheck: true,
      output: "Write docs.md",
    })
    expect(fs.existsSync(path.join(root, "next"))).toBe(false)

    fs.writeFileSync(path.join(root, "docs.md"), "")
    const done = runHooks(
      root,
      hooks,
      request(["ready.before"], "ready", { after: "ready.before/docs" }),
    )
    expect(done.status).toBe("done")
    expect(done.ran.map((r) => [r.name, r.result, r.recheck])).toEqual([
      ["docs", "passed", true],
      ["next", "passed", undefined],
    ])
  })

  it("leaves a hook running at --max-wait, and --wait picks it up and goes on", () => {
    const root = repo()
    const hooks = config({
      ready: {
        before: [
          { name: "slow", run: "sleep 1; echo slept > slow.txt" },
          { name: "next", run: "touch next" },
        ],
      },
    })
    const first = runHooks(
      root,
      hooks,
      request(["ready.before"], "ready", { maxWait: 0.2 }),
    )
    expect(first).toMatchObject({
      status: "running",
      running: { name: "slow", resume: "ready.before/slow" },
    })
    expect(first.running?.pid).toBeTypeOf("number")
    expect(fs.existsSync(path.join(root, "next"))).toBe(false)

    const second = runHooks(
      root,
      hooks,
      request(["ready.before"], "ready", { wait: first.running?.resume }),
    )
    expect(second.status).toBe("done")
    expect(second.ran.map((r) => [r.name, r.result])).toEqual([
      ["slow", "passed"],
      ["next", "passed"],
    ])
    expect(fs.readFileSync(path.join(root, "slow.txt"), "utf8")).toBe("slept\n")
    expect(
      fs.readdirSync(path.join(root, ".git/agent-flows/hooks/running")),
    ).toEqual([])
  })

  it("times out a hook left running, even with nobody waiting on it", () => {
    const root = repo()
    const hooks = config({
      ready: { before: [{ name: "slow", run: "sleep 5", timeout: 1 }] },
    })
    const first = runHooks(
      root,
      hooks,
      request(["ready.before"], "ready", { maxWait: 0.1 }),
    )
    expect(first.status).toBe("running")
    spawnSync("sleep", ["1.5"])
    const second = runHooks(
      root,
      hooks,
      request(["ready.before"], "ready", { wait: "ready.before/slow" }),
    )
    expect(second.stop?.result).toBe("timedOut")
  })

  it("does nothing, and reads no git, when no hooks are configured", () => {
    const root = repo()
    expect(runHooks(root, config({}), request(["before"], "evaluate"))).toEqual(
      {
        status: "done",
        ran: [],
        failures: [],
      },
    )
    expect(fs.existsSync(path.join(root, ".git/agent-flows/hooks"))).toBe(false)
  })
})

describe("parsePoints", () => {
  it("reads general and flow points, and keeps each flow to its own", () => {
    expect(
      parsePoints(["before", "ready.after"], "ready").map((p) => p.id),
    ).toEqual(["hooks.before", "ready.after"])
    expect(
      parsePoints(["ready.beforeFixPush"], "ready").map((p) => p.failure),
    ).toEqual(["stop"])
    expect(() => parsePoints(["merge.after"], "ready")).toThrow("merge's point")
    expect(() => parsePoints(["before"], "configure")).toThrow("--flow")
    expect(() => parsePoints(["ready.during"], "ready")).toThrow(
      "no hook point",
    )
  })
})

describe("tryHook", () => {
  it("runs a hook that isn't configured, ignoring its filters and never its fix", () => {
    const root = repo()
    const point = parsePoints(["ready.before"], "ready")[0] as HookPoint
    const passed = tryHook(
      root,
      config({}),
      point,
      { name: "ok", paths: ["nothing/**"], run: "touch tried" },
      { flow: "ready" },
    )
    expect(passed.status).toBe("done")
    expect(fs.existsSync(path.join(root, "tried"))).toBe(true)

    const failed = tryHook(
      root,
      config({}),
      point,
      { name: "bump", run: "test -f bumped", fix: "touch bumped" },
      { flow: "ready" },
    )
    expect(failed).toMatchObject({
      status: "stop",
      fix: "not run: it would change the checkout (touch bumped)",
    })
    expect(fs.existsSync(path.join(root, "bumped"))).toBe(false)
  })

  it("refuses an after point and a hook that isn't valid", () => {
    const root = repo()
    const [after] = parsePoints(["merge.after"], "merge")
    const [before] = parsePoints(["ready.before"], "ready")
    expect(() =>
      tryHook(
        root,
        config({}),
        after as HookPoint,
        { name: "x", run: "true" },
        { flow: "merge" },
      ),
    ).toThrow("isn't tried")
    expect(() =>
      tryHook(
        root,
        config({}),
        before as HookPoint,
        { name: "x" },
        { flow: "ready" },
      ),
    ).toThrow("must have either run or prompt")
  })
})

describe("findings", () => {
  it("hands a passing command's output to the agent at evaluate.scan, and nowhere else", () => {
    const root = repo({ "src/a.ts": "" })
    const hooks = [
      { name: "scan", run: "echo 'FLAG src/a.ts:1 hardcoded id'" },
      { name: "quiet", run: "true" },
    ]
    const scan = runHooks(
      root,
      config({ evaluate: { scan: hooks } }),
      request(["evaluate.scan"], "evaluate", { mode: "default" }),
    )
    expect(scan.status).toBe("done")
    expect(scan.findings).toEqual([
      {
        point: "evaluate.scan",
        name: "scan",
        output: "FLAG src/a.ts:1 hardcoded id",
        log: expect.stringContaining("evaluate.scan-scan.log"),
      },
    ])

    const ready = runHooks(
      root,
      config({ ready: { before: hooks } }),
      request(["ready.before"], "ready", { mode: "default" }),
    )
    expect(ready.findings).toBeUndefined()
  })

  it("keeps only the lines a findings regex matches, and counts the budget after", () => {
    const root = repo()
    const noise = Array.from({ length: 500 }, (_, i) => `noise ${i}`).join(
      "\\n",
    )
    const report = runHooks(
      root,
      config({
        evaluate: {
          scan: [
            {
              name: "scan",
              run: `printf '${noise}\\nFINDING: a\\n  CHECK: b\\nnot this\\nUNTESTED: c\\n'`,
              findings: "^(FINDING|  CHECK|UNTESTED):",
            },
            { name: "none", run: "echo nothing to see", findings: "^FINDING:" },
          ],
        },
      }),
      request(["evaluate.scan"], "evaluate"),
    )
    expect(report.findings?.map((f) => [f.name, f.output])).toEqual([
      ["scan", "FINDING: a\n  CHECK: b\nUNTESTED: c"],
    ])
  })

  it("stops on a scan that exits 2, since a scan only reads", () => {
    const root = repo()
    const report = runHooks(
      root,
      config({
        evaluate: {
          scan: [{ name: "scan", run: "echo 'fix this' >&2; exit 2" }],
        },
      }),
      request(["evaluate.scan"], "evaluate"),
    )
    expect(report.status).toBe("stop")
    expect(report.stop).toMatchObject({ name: "scan", output: "fix this" })
  })
})

describe("checkFlags", () => {
  it("takes each flow's own values, and one way to resume", () => {
    const flags = (entries: Record<string, string>) =>
      new Map(Object.entries(entries))
    expect(() => checkFlags(flags({ result: "full" }), "sync")).not.toThrow()
    expect(() => checkFlags(flags({ result: "maybe" }), "sync")).toThrow(
      "--result for sync must be noop, local, remote, full",
    )
    expect(() => checkFlags(flags({ result: "full" }), "ready")).toThrow(
      "--result is only for sync",
    )
    expect(() => checkFlags(flags({ scope: "some" }), "evaluate")).toThrow(
      "--scope must be full, delta, carry",
    )
    expect(() => checkFlags(flags({ merged: "yes" }), "ready")).toThrow(
      "--merged is only for merge",
    )
    expect(() =>
      checkFlags(flags({ after: "a/b", wait: "a/b" }), "ready"),
    ).toThrow("not both")
    expect(() => checkFlags(flags({ "max-wait": "0" }), "ready")).toThrow(
      "--max-wait takes a number of seconds",
    )
  })
})

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { HookPoint } from "../config/hooks.ts"
import type { Hook } from "../config/types.ts"
import { type HookRequest, parsePoints, runHooks, tryHook } from "./hooks.ts"

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

  it("fails a command that runs past its timeout, without trying its fix", () => {
    const root = repo()
    const report = runHooks(
      root,
      config({
        ready: {
          before: [
            { name: "slow", run: "sleep 5", fix: "touch fixed", timeout: 1 },
          ],
        },
      }),
      request(["ready.before"], "ready"),
    )
    expect(report.stop?.result).toBe("timedOut")
    expect(fs.existsSync(path.join(root, "fixed"))).toBe(false)
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

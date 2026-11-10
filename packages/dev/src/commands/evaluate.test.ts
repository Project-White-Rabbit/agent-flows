import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  combineDelta,
  fileChanges,
  findingAnchors,
  gate,
  moved,
  readRecord,
  record,
  runTests,
  scope,
  settings,
  stopsAtHigh,
  worse,
} from "./evaluate.ts"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function sh(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  }
  return result.stdout.trim()
}

function write(root: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), text)
}

function commit(root: string, message: string): string {
  sh(root, "add", "-A")
  sh(root, "commit", "-q", "-m", message)
  return sh(root, "rev-parse", "HEAD")
}

/** A repo with a bare origin, `main` with two files, and `feature` off it. */
function setup(): { root: string } {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "evaluate-"))
  dirs.push(top)
  const origin = path.join(top, "origin.git")
  sh(top, "init", "-q", "--bare", origin)
  const root = path.join(top, "work")
  sh(top, "init", "-q", "-b", "main", root)
  sh(root, "config", "user.email", "t@example.com")
  sh(root, "config", "user.name", "T")
  sh(root, "remote", "add", "origin", origin)
  write(root, "a.ts", "one\ntwo\nthree\n")
  write(root, "b.ts", "x\n")
  commit(root, "base")
  sh(root, "push", "-q", "origin", "main")
  sh(root, "checkout", "-q", "-b", "feature")
  write(root, "a.ts", "one\ntwo changed\nthree\n")
  write(root, "c.ts", "new\n")
  commit(root, "work")
  sh(root, "push", "-q", "origin", "feature")
  return { root }
}

const DELTA = {
  evaluate: { scope: "delta", record: true },
  finish: { requireEvaluation: "pass" },
}

/** Push HEAD to origin's feature, so a record takes it. */
function push(root: string): void {
  sh(root, "push", "-q", "origin", "feature")
}

describe("settings", () => {
  it("defaults to a full review by the session, recording nothing", () => {
    expect(settings({})).toEqual({
      record: false,
      scope: "full",
      reviewer: "session",
      stopOn: "rethink",
      fetch: false,
      instructions: [],
      tests: null,
      requireEvaluation: null,
    })
  })

  it("reads stopOn, fetch, instructions, and tests", () => {
    expect(
      settings({
        evaluate: {
          stopOn: "high",
          fetch: true,
          instructions: ["docs/review.md"],
          tests: "vitest run {tests}",
        },
      }),
    ).toMatchObject({
      stopOn: "high",
      fetch: true,
      instructions: ["docs/review.md"],
      tests: "vitest run {tests}",
    })
  })
})

describe("worse and moved", () => {
  it("keeps the worse verdict", () => {
    expect(worse("pass", "flag")).toBe("flag")
    expect(worse("stop", "flag")).toBe("stop")
    expect(worse("pass", "pass")).toBe("pass")
  })

  it("names the files whose change moved, and the ones no longer changed", () => {
    expect(
      moved({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" }),
    ).toEqual({ review: ["b", "c"], dropped: ["d"] })
  })
})

describe("findingAnchors", () => {
  it("reads the files after a line's last ` @ `, without line numbers", () => {
    expect(
      findingAnchors(
        "[HIGH] Migration: drops a column old code reads. @ db/schema.ts:12, api/x.ts",
      ),
    ).toEqual(["db/schema.ts", "api/x.ts"])
    expect(
      findingAnchors("[MEDIUM] Edge: mail me@ home. @ src/a b.ts:3-9"),
    ).toEqual(["src/a b.ts"])
  })

  it("is empty for a line with no anchor", () => {
    expect(findingAnchors("Address first: no test")).toEqual([])
    expect(findingAnchors("[LOW] Docs: user@example.com is stale")).toEqual([])
  })
})

describe("combineDelta", () => {
  const previous = {
    verdict: "flag" as const,
    summary: [
      "Address first: two risks",
      "[HIGH] Blast radius: retries forever. @ a.ts:3",
      "[MEDIUM] Edge cases: empty input. @ b.ts",
      "[MEDIUM] Coupling: both sides. @ a.ts, b.ts",
      "[MEDIUM] Monitoring: no alert",
    ],
  }

  it("drops the findings anchored only in re-reviewed files, and keeps the rest", () => {
    const combined = combineDelta(
      previous,
      { verdict: "pass", summary: ["Ship: fixed"] },
      ["a.ts"],
    )
    expect(combined.kept).toEqual([
      "[MEDIUM] Edge cases: empty input. @ b.ts",
      "[MEDIUM] Coupling: both sides. @ a.ts, b.ts",
      "[MEDIUM] Monitoring: no alert",
    ])
    expect(combined.summary[0]).toBe("Ship: fixed")
    expect(combined.verdict).toBe("flag")
  })

  it("lets the verdict improve when every earlier finding was re-checked", () => {
    const combined = combineDelta(
      { verdict: "flag", summary: previous.summary.slice(0, 4) },
      { verdict: "pass", summary: ["Ship: fixed"] },
      ["a.ts", "b.ts"],
    )
    expect(combined).toEqual({
      verdict: "pass",
      summary: ["Ship: fixed"],
      kept: [],
    })
  })

  it("keeps a finding the delta found again only once, and never lowers the new verdict", () => {
    const again = "[MEDIUM] Edge cases: empty input. @ b.ts"
    const combined = combineDelta(
      previous,
      { verdict: "flag", summary: ["Address first: still", again] },
      [],
    )
    expect(combined.summary.filter((line) => line === again)).toHaveLength(1)
    expect(combined.verdict).toBe("flag")
  })
})

describe("stopsAtHigh", () => {
  it("is a HIGH risk or a STOP scan finding", () => {
    expect(stopsAtHigh("[HIGH] Migration: x @ a.ts")).toBe(true)
    expect(stopsAtHigh("[STOP] Scan: x @ a.ts")).toBe(true)
    expect(stopsAtHigh("[MEDIUM] Migration: x @ a.ts")).toBe(false)
  })
})

describe("fileChanges", () => {
  it("keeps a file's id when the base moves under it, and changes it when the file does", () => {
    const { root } = setup()
    const before = fileChanges(root, sh(root, "merge-base", "main", "HEAD"))
    expect(Object.keys(before)).toEqual(["a.ts", "c.ts"])

    sh(root, "checkout", "-q", "main")
    write(root, "a.ts", "zero\none\ntwo\nthree\n")
    write(root, "b.ts", "y\n")
    commit(root, "base moves")
    sh(root, "checkout", "-q", "feature")
    sh(root, "merge", "-q", "--no-edit", "main")
    const after = fileChanges(root, sh(root, "merge-base", "main", "HEAD"))
    expect(after).toEqual(before)

    write(root, "c.ts", "newer\n")
    const edited = fileChanges(root, sh(root, "merge-base", "main", "HEAD"))
    expect(edited["c.ts"]).not.toBe(before["c.ts"])
    expect(edited["a.ts"]).toBe(before["a.ts"])
  })

  it("hashes untracked files by content", () => {
    const { root } = setup()
    write(root, "d.ts", "loose\n")
    const files = fileChanges(root, sh(root, "merge-base", "main", "HEAD"))
    expect(files["d.ts"]).toMatch(/^untracked:/)
  })
})

describe("scope", () => {
  it("is full unless evaluate.scope is delta", () => {
    const { root } = setup()
    const report = scope(root, {}, "main")
    expect(report.scope).toBe("full")
    expect(report.review).toEqual(["a.ts", "c.ts"])
  })

  it("is full with no record, then carry, then a delta of what moved", () => {
    const { root } = setup()
    expect(scope(root, DELTA, "main").scope).toBe("full")
    record(root, {
      base: "main",
      scope: "full",
      verdict: "pass",
      summary: ["Ship: small change"],
    })
    expect(scope(root, DELTA, "main").scope).toBe("carry")

    write(root, "c.ts", "newer\n")
    const delta = scope(root, DELTA, "main")
    expect(delta.scope).toBe("delta")
    expect(delta.review).toEqual(["c.ts"])
    expect(delta.previous?.verdict).toBe("pass")
    expect(delta.since).toBe(delta.previous?.sha)
  })

  it("names the commit a carry or delta starts from, and none for a full review", () => {
    const { root } = setup()
    expect(scope(root, DELTA, "main").since).toBeNull()
    record(root, {
      base: "main",
      scope: "full",
      verdict: "pass",
      summary: ["ok"],
    })
    const carry = scope(root, DELTA, "main")
    expect(carry.since).toBe(sh(root, "rev-parse", "HEAD"))
    expect(carry.why).toMatch(/already/)
  })

  it("is full when asked for, whatever the record says", () => {
    const { root } = setup()
    record(root, {
      base: "main",
      scope: "full",
      verdict: "pass",
      summary: ["ok"],
    })
    const report = scope(root, DELTA, "main", { full: true })
    expect(report).toMatchObject({
      scope: "full",
      review: ["a.ts", "c.ts"],
      since: null,
      why: "a full review was asked for",
    })
    expect(report.previous?.verdict).toBe("pass")
  })

  it("is full after a stop, so the verdict can clear", () => {
    const { root } = setup()
    record(root, {
      base: "main",
      scope: "full",
      verdict: "stop",
      summary: ["Rethink: wrong layer"],
    })
    write(root, "c.ts", "newer\n")
    const report = scope(root, DELTA, "main")
    expect(report.scope).toBe("full")
    expect(report.why).toMatch(/is stop/)
  })
})

describe("record", () => {
  it("refuses a dirty tree", () => {
    const { root } = setup()
    write(root, "c.ts", "uncommitted\n")
    const result = record(root, {
      base: "main",
      scope: "full",
      verdict: "pass",
      summary: ["ok"],
    })
    expect(result.recorded).toBe(false)
    expect(result.recorded === false && result.reason).toMatch(/uncommitted/)
    expect(readRecord(root, "feature")).toBeUndefined()
  })

  it("refuses a HEAD that isn't pushed", () => {
    const { root } = setup()
    write(root, "c.ts", "local only\n")
    commit(root, "unpushed")
    const result = record(root, {
      base: "main",
      scope: "full",
      verdict: "pass",
      summary: ["ok"],
    })
    expect(result.recorded === false && result.reason).toMatch(/isn't origin/)
  })

  it("keeps a delta's earlier findings in files it didn't review, and carries a verdict", () => {
    const { root } = setup()
    record(root, {
      base: "main",
      scope: "full",
      verdict: "flag",
      summary: [
        "Address first: two risks",
        "[MEDIUM] Edge cases: empty input. @ a.ts:2",
        "[MEDIUM] Coherence: no test. @ c.ts",
      ],
    })
    write(root, "c.ts", "newer\n")
    const sha = commit(root, "more")
    push(root)
    const delta = record(root, {
      base: "main",
      scope: "delta",
      verdict: "pass",
      summary: ["Ship: fine"],
    })
    expect(delta).toMatchObject({
      recorded: true,
      kept: ["[MEDIUM] Edge cases: empty input. @ a.ts:2"],
      record: {
        sha,
        verdict: "flag",
        summary: ["Ship: fine", "[MEDIUM] Edge cases: empty input. @ a.ts:2"],
        scope: "delta",
      },
    })

    sh(root, "commit", "-q", "--allow-empty", "-m", "empty")
    push(root)
    const carried = record(root, { base: "main", scope: "carry" })
    expect(carried.recorded && carried.record).toMatchObject({
      verdict: "flag",
      scope: "carry",
      carriedFrom: sha,
    })
  })

  it("lets a delta pass once it has re-checked every earlier finding", () => {
    const { root } = setup()
    record(root, {
      base: "main",
      scope: "full",
      verdict: "flag",
      summary: [
        "Address first: no test",
        "[MEDIUM] Coherence: no test. @ c.ts",
      ],
    })
    write(root, "c.ts", "tested\n")
    commit(root, "test")
    push(root)
    const delta = record(root, {
      base: "main",
      scope: "delta",
      verdict: "pass",
      summary: ["Ship: tested now"],
    })
    expect(delta.recorded && delta.record).toMatchObject({
      verdict: "pass",
      summary: ["Ship: tested now"],
    })
  })

  it("writes nothing for a carry onto the commit the record already names", () => {
    const { root } = setup()
    const first = record(root, {
      base: "main",
      scope: "full",
      verdict: "pass",
      summary: ["ok"],
    })
    const carried = record(root, { base: "main", scope: "carry" })
    expect(carried).toMatchObject({ recorded: true, unchanged: true })
    expect(readRecord(root, "feature")).toEqual(
      first.recorded ? first.record : undefined,
    )
    expect(readRecord(root, "feature")?.carriedFrom).toBeUndefined()
  })

  it("refuses when the record changed since scope read it", () => {
    const { root } = setup()
    const seen = scope(root, DELTA, "main").previous?.sha ?? null
    record(root, {
      base: "main",
      scope: "full",
      verdict: "pass",
      summary: ["a"],
    })
    const late = record(root, {
      base: "main",
      scope: "full",
      verdict: "flag",
      summary: ["b"],
      previous: seen,
    })
    expect(late.recorded === false && late.reason).toMatch(
      /changed since scope read it/,
    )
    expect(readRecord(root, "feature")?.verdict).toBe("pass")

    const sha = readRecord(root, "feature")?.sha
    expect(
      record(root, {
        base: "main",
        scope: "full",
        verdict: "flag",
        summary: ["b"],
        previous: sha,
      }).recorded,
    ).toBe(true)
  })

  it("records a HIGH or STOP finding as stop with evaluate.stopOn high", () => {
    const { root } = setup()
    const summary = [
      "Address first: retries forever",
      "[HIGH] Blast radius: retries forever. @ a.ts:2",
    ]
    const rethink = record(root, {
      base: "main",
      scope: "full",
      verdict: "flag",
      summary,
    })
    expect(rethink.recorded && rethink.record.verdict).toBe("flag")
    const high = record(
      root,
      { base: "main", scope: "full", verdict: "flag", summary },
      { evaluate: { stopOn: "high" } },
    )
    expect(high).toMatchObject({
      recorded: true,
      escalated: true,
      record: { verdict: "stop" },
    })
    const scan = record(
      root,
      {
        base: "main",
        scope: "full",
        verdict: "flag",
        summary: ["Address first: scan", "[STOP] Scan: secret in a.ts. @ a.ts"],
      },
      { evaluate: { stopOn: "high" } },
    )
    expect(scan.recorded && scan.record.verdict).toBe("stop")
    const medium = record(
      root,
      {
        base: "main",
        scope: "full",
        verdict: "flag",
        summary: ["Address first: x", "[MEDIUM] Edge cases: x. @ a.ts"],
      },
      { evaluate: { stopOn: "high" } },
    )
    expect(medium.recorded && medium.record.verdict).toBe("flag")
  })
})

describe("runTests", () => {
  const base = (root: string) => sh(root, "merge-base", "main", "HEAD")

  it("doesn't run without evaluate.tests, or with no tests", () => {
    const { root } = setup()
    expect(
      runTests(root, {}, { base: base(root), tests: ["a.test.ts"] }),
    ).toEqual({ ran: false, reason: "evaluate.tests is unset" })
    expect(
      runTests(
        root,
        { evaluate: { tests: "echo {tests}" } },
        { base: base(root), tests: [] },
      ).ran,
    ).toBe(false)
  })

  it("runs the command on the quoted tests, keeping its output in a log", () => {
    const { root } = setup()
    const result = runTests(
      root,
      { evaluate: { tests: "echo ran {tests} since {base}" } },
      { base: base(root), tests: ["a.test.ts", "b c.test.ts"] },
    )
    expect(result).toMatchObject({
      ran: true,
      passed: true,
      exitCode: 0,
      command: `echo ran a.test.ts 'b c.test.ts' since ${base(root)}`,
    })
    if (!result.ran) {
      throw new Error("expected a run")
    }
    expect(result.tail).toBe(`ran a.test.ts b c.test.ts since ${base(root)}`)
    expect(result.log).toContain(path.join(".git", "agent-flows", "evaluate"))
    expect(fs.readFileSync(result.log, "utf8")).toContain("ran a.test.ts")
  })

  it("reports a failing run without throwing", () => {
    const { root } = setup()
    const result = runTests(
      root,
      { evaluate: { tests: "echo failing {tests}; exit 3" } },
      { base: base(root), tests: ["a.test.ts"] },
    )
    expect(result).toMatchObject({ ran: true, passed: false, exitCode: 3 })
  })
})

describe("gate", () => {
  it("is off without finish.requireEvaluation", () => {
    const { root } = setup()
    expect(gate(root, {}, "main")).toEqual({ gate: "off" })
  })

  it("stops with no record, passes a current pass, and asks on a flag", () => {
    const { root } = setup()
    expect(gate(root, DELTA, "main")).toMatchObject({
      gate: "stop",
      rerun: true,
    })
    record(root, {
      base: "main",
      scope: "full",
      verdict: "pass",
      summary: ["ok"],
    })
    expect(gate(root, DELTA, "main").gate).toBe("pass")
    record(root, {
      base: "main",
      scope: "full",
      verdict: "flag",
      summary: ["hmm"],
    })
    expect(gate(root, DELTA, "main").gate).toBe("ask")
    expect(
      gate(root, { ...DELTA, finish: { requireEvaluation: "flag" } }, "main")
        .gate,
    ).toBe("pass")
  })

  it("carries a verdict across a base merge, and stops when a file moved", () => {
    const { root } = setup()
    record(root, {
      base: "main",
      scope: "full",
      verdict: "pass",
      summary: ["ok"],
    })
    sh(root, "checkout", "-q", "main")
    write(root, "b.ts", "y\n")
    commit(root, "base moves")
    sh(root, "checkout", "-q", "feature")
    sh(root, "merge", "-q", "--no-edit", "main")
    const carried = gate(root, DELTA, "main")
    expect(carried).toMatchObject({ gate: "pass", carried: true })
    expect(readRecord(root, "feature")?.sha).toBe(sh(root, "rev-parse", "HEAD"))

    write(root, "c.ts", "newer\n")
    commit(root, "edit")
    const stopped = gate(root, DELTA, "main")
    expect(stopped.gate).toBe("stop")
    expect(stopped.rerun).toBe(true)
    expect(stopped.reason).toMatch(/changed since: c.ts/)
  })

  it("stops on a stop verdict with nothing a fresh evaluation settles", () => {
    const { root } = setup()
    record(root, {
      base: "main",
      scope: "full",
      verdict: "stop",
      summary: ["Rethink: wrong layer"],
    })
    const stopped = gate(root, DELTA, "main")
    expect(stopped.gate).toBe("stop")
    expect(stopped.rerun).toBeUndefined()
  })

  it("doesn't carry with a full scope", () => {
    const { root } = setup()
    record(root, {
      base: "main",
      scope: "full",
      verdict: "pass",
      summary: ["ok"],
    })
    sh(root, "commit", "-q", "--allow-empty", "-m", "empty")
    expect(
      gate(root, { finish: { requireEvaluation: "pass" } }, "main").gate,
    ).toBe("stop")
  })
})

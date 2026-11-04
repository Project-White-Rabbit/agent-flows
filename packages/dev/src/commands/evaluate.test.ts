import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  fileChanges,
  gate,
  moved,
  readRecord,
  record,
  scope,
  settings,
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
  merge: { requireEvaluation: "pass" },
}

describe("settings", () => {
  it("defaults to a full review by the session, recording nothing", () => {
    expect(settings({})).toEqual({
      record: false,
      scope: "full",
      reviewer: "session",
      requireEvaluation: null,
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

  it("keeps the worse verdict and both summaries on a delta, and carries a verdict", () => {
    const { root } = setup()
    record(root, {
      base: "main",
      scope: "full",
      verdict: "flag",
      summary: ["Address first: no test"],
    })
    write(root, "c.ts", "newer\n")
    const sha = commit(root, "more")
    sh(root, "push", "-q", "origin", "feature")
    const delta = record(root, {
      base: "main",
      scope: "delta",
      verdict: "pass",
      summary: ["Ship: fine"],
    })
    expect(delta.recorded && delta.record).toMatchObject({
      sha,
      verdict: "flag",
      summary: ["Ship: fine", "Address first: no test"],
      scope: "delta",
    })

    sh(root, "commit", "-q", "--allow-empty", "-m", "empty")
    sh(root, "push", "-q", "origin", "feature")
    const carried = record(root, { base: "main", scope: "carry" })
    expect(carried.recorded && carried.record).toMatchObject({
      verdict: "flag",
      scope: "carry",
      carriedFrom: sha,
    })
  })
})

describe("gate", () => {
  it("is off without merge.requireEvaluation", () => {
    const { root } = setup()
    expect(gate(root, {}, "main")).toEqual({ gate: "off" })
  })

  it("stops with no record, passes a current pass, and asks on a flag", () => {
    const { root } = setup()
    expect(gate(root, DELTA, "main").gate).toBe("stop")
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
      gate(root, { ...DELTA, merge: { requireEvaluation: "flag" } }, "main")
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
    expect(stopped.reason).toMatch(/changed since: c.ts/)
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
      gate(root, { merge: { requireEvaluation: "pass" } }, "main").gate,
    ).toBe("stop")
  })
})

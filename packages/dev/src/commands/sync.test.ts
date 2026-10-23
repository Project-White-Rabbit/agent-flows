import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  BLOCK_END,
  BLOCK_START,
  type BranchState,
  gate,
  lastSyncedLine,
  parsePr,
  spliceBlock,
  workState,
} from "./sync.ts"

const clean = {
  mode: "default" as const,
  onBase: false,
  dirty: false,
  ahead: 2,
  behind: 0,
  unpushed: 0,
  head: "abc",
  pr: parsePr("12:open:true"),
}

const synced: BranchState = {
  remote: { head: "abc", pr: "12:open:true", linkedRefs: [] },
}

describe("gate", () => {
  it("is a no-op when nothing changed since the last sync", () => {
    expect(gate({ ...clean, stored: synced })).toEqual({
      runLocal: false,
      runRemote: false,
      noop: true,
      newErrorRefs: [],
    })
  })

  it("runs local work for a dirty tree, a moved base, or unpushed commits", () => {
    for (const change of [
      { dirty: true },
      { behind: 1 },
      { unpushed: 1 },
      { unpushed: undefined },
      { onBase: true },
    ]) {
      expect(gate({ ...clean, ...change, stored: synced }).runLocal).toBe(true)
    }
  })

  it("follows local work with remote writes in default mode only", () => {
    const dirty = { ...clean, dirty: true, stored: synced }
    expect(gate(dirty).runRemote).toBe(true)
    expect(gate({ ...dirty, mode: "local" }).runRemote).toBe(false)
  })

  it("never pushes in local mode, so unpushed commits don't count", () => {
    expect(
      gate({ ...clean, mode: "local", unpushed: 3, stored: synced }).noop,
    ).toBe(true)
  })

  it("runs remote writes when the PR or HEAD moved, or a ref is unlinked", () => {
    expect(
      gate({ ...clean, pr: parsePr("12:open:false"), stored: synced }),
    ).toMatchObject({ runRemote: true, runLocal: false })
    expect(gate({ ...clean, head: "def", stored: synced }).runRemote).toBe(true)
    expect(gate({ ...clean, pr: undefined, stored: synced }).runRemote).toBe(
      true,
    )
    const refs = gate({
      ...clean,
      stored: { ...synced, errorRefs: ["WEB-1", "WEB-2"] },
    })
    expect(refs).toMatchObject({
      runRemote: true,
      newErrorRefs: ["WEB-1", "WEB-2"],
    })
  })

  it("never runs local work in remote mode", () => {
    expect(
      gate({
        ...clean,
        mode: "remote",
        dirty: true,
        behind: 4,
        stored: synced,
      }),
    ).toMatchObject({ runLocal: false, noop: true })
  })
})

describe("workState", () => {
  it("derives the issue state from the PR and the branch", () => {
    expect(workState(parsePr("1:merged:false"), 3)).toBe("done")
    expect(workState(parsePr("1:closed:false"), 3)).toBe("canceled")
    expect(workState(undefined, 0)).toBe("todo")
    expect(workState(undefined, 2)).toBe("in progress")
    expect(workState(parsePr("1:open:true"), 2)).toBe("in progress")
    expect(workState(parsePr("1:open:false"), 2)).toBe("in review")
  })
})

describe("parsePr", () => {
  it("reads none and number:state:draft, and rejects anything else", () => {
    expect(parsePr("none")).toBeUndefined()
    expect(parsePr("7:OPEN:true")).toEqual({
      number: "7",
      state: "open",
      draft: true,
    })
    expect(() => parsePr("7:open")).toThrow(/--pr must be/)
  })
})

describe("spliceBlock", () => {
  it("puts the block on top of a body without one, keeping the body", () => {
    expect(spliceBlock("Notes from a human.\n", "## Summary\n\n- x")).toBe(
      `${BLOCK_START}\n## Summary\n\n- x\n${BLOCK_END}\n\nNotes from a human.\n`,
    )
    expect(spliceBlock("", "## Summary")).toBe(
      `${BLOCK_START}\n## Summary\n${BLOCK_END}\n`,
    )
  })

  it("replaces only its own block on a re-run", () => {
    const first = spliceBlock("Above\n\nBelow", "old")
    const edited = `Intro\n\n${first}\n\nAdded later`
    const second = spliceBlock(edited, `${BLOCK_START}\nnew\n${BLOCK_END}`)
    expect(second).toContain("Intro")
    expect(second).toContain("Added later")
    expect(second).toContain("new")
    expect(second).not.toContain("old")
    expect(second.split(BLOCK_START)).toHaveLength(2)
  })
})

describe("lastSyncedLine", () => {
  it("stamps the time and the short HEAD", () => {
    expect(
      lastSyncedLine("0123456789abcdef", new Date("2026-10-23T20:41:09Z")),
    ).toBe("_Last synced: 2026-10-23 20:41 UTC (HEAD: 0123456)_")
  })
})

describe("sync.ts (as a script)", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const script = path.join(import.meta.dirname, "sync.ts")
  const work = () => path.join(dir as string, "work")
  const sync = (args: string[]) =>
    spawnSync("node", [script, ...args], { cwd: work(), encoding: "utf8" })
  const json = (args: string[]) => {
    const result = sync(args)
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    return JSON.parse(result.stdout)
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", work(), ...args], { encoding: "utf8" })

  function init(): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-sync-"))
    const origin = path.join(dir, "origin.git")
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin])
    execFileSync("git", ["clone", "-q", origin, work()], { stdio: "ignore" })
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    git("commit", "-q", "--allow-empty", "-m", "Init")
    git("push", "-q", "origin", "HEAD:main")
    git("switch", "-q", "-c", "feature")
  }

  it("gates on what changed since finish recorded the last sync", () => {
    init()
    const survey = ["survey", "default", "--base", "main", "--pr", "none"]
    expect(json(survey)).toMatchObject({
      branch: "feature",
      baseRef: "origin/main",
      ahead: 0,
      behind: 0,
      runLocal: false,
      runRemote: true,
    })

    fs.writeFileSync(path.join(work(), "a.txt"), "a")
    expect(json(survey)).toMatchObject({ dirty: true, runLocal: true })

    git("add", "-A")
    git("commit", "-q", "-m", "Add a")
    git("push", "-q", "-u", "origin", "HEAD")
    const pr = ["--pr", "5:open:true"]
    expect(
      json(["finish", "--base", "main", ...pr, "--remote", "--issue", "ENG-1"]),
    ).toMatchObject({ written: true, branch: "feature" })

    const again = json(["survey", "default", "--base", "main", ...pr])
    expect(again).toMatchObject({
      ahead: 1,
      unpushed: 0,
      issue: "ENG-1",
      noop: true,
    })
    expect(json(["facts", "--base", "main", ...pr])).toMatchObject({
      workState: "in progress",
      updateKind: "metadata-only",
    })

    // A new error ref reopens the remote writes until a remote sync links it.
    expect(
      json([
        "survey",
        "remote",
        "--base",
        "main",
        ...pr,
        "--error-ref",
        "WEB-1",
      ]),
    ).toMatchObject({ newErrorRefs: ["WEB-1"], runRemote: true })
    json([
      "finish",
      "--base",
      "main",
      ...pr,
      "--remote",
      "--linked-ref",
      "WEB-1",
    ])
    expect(json(["survey", "remote", "--base", "main", ...pr])).toMatchObject({
      errorRefs: ["WEB-1"],
      newErrorRefs: [],
      noop: true,
    })

    // A dropped issue is forgotten.
    json(["finish", "--base", "main", ...pr, "--issue", "none"])
    expect(json(["survey", "remote", "--base", "main", ...pr]).issue).toBeNull()

    // The PR becoming ready is a remote change only.
    expect(
      json(["survey", "default", "--base", "main", "--pr", "5:open:false"]),
    ).toMatchObject({ runLocal: false, runRemote: true })
  })

  it("keeps its state out of the working tree", () => {
    init()
    json(["finish", "--base", "main", "--pr", "none"])
    expect(git("status", "--porcelain")).toBe("")
  })

  it("refuses a detached HEAD", () => {
    init()
    git("checkout", "-q", "--detach")
    const result = sync(["survey", "default", "--base", "main", "--pr", "none"])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/detached/)
  })

  it("splices a block into a body file", () => {
    init()
    const body = path.join(dir as string, "body.md")
    const block = path.join(dir as string, "block.md")
    fs.writeFileSync(body, "Human notes")
    fs.writeFileSync(block, "## Summary")
    const result = sync(["splice", "--body", body, "--block", block])
    expect(result.stdout).toBe(
      `${BLOCK_START}\n## Summary\n${BLOCK_END}\n\nHuman notes\n`,
    )
  })
})

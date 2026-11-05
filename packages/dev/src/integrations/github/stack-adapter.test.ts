import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createdFrom,
  downstackOp,
  findParent,
  mergeStackOp,
  type OpenPr,
  parentOp,
  type RunResult,
  recordedParents,
  reparentOp,
  restackOp,
  type Shell,
  type StackContext,
  submitOp,
  trackOp,
} from "./stack-adapter.ts"

// A real origin and clone for git, and a scripted `gh`: each test answers the
// `gh` calls it expects and sees every one made.

let root: string
let work: string

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: "pipe",
  }).trim()
}

function commit(dir: string, file: string, text: string, message: string) {
  fs.writeFileSync(path.join(dir, file), text)
  git(dir, "add", file)
  git(dir, "commit", "-q", "-m", message)
}

function clone(name: string): string {
  const dir = path.join(root, name)
  git(root, "clone", "-q", path.join(root, "origin.git"), dir)
  git(dir, "config", "user.name", "Test")
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "commit.gpgsign", "false")
  return dir
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-gh-stack-"))
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git")
  work = clone("work")
  git(work, "switch", "-q", "-c", "main")
  commit(work, "base.txt", "base\n", "base")
  git(work, "push", "-q", "-u", "origin", "main")
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

type Gh = (args: string[]) => string | RunResult | undefined

/** A shell running real git in `dir`, and `gh` through `gh`. */
function fakeShell(dir: string, gh: Gh): Shell & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    run(bin, args) {
      if (bin === "git") {
        const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" })
        return {
          status: result.status ?? 1,
          stdout: result.stdout,
          stderr: result.stderr,
        }
      }
      calls.push(args.join(" "))
      const answer = gh(args)
      if (answer === undefined) {
        return {
          status: 1,
          stdout: "",
          stderr: `unexpected gh ${args.join(" ")}`,
        }
      }
      return typeof answer === "string"
        ? { status: 0, stdout: answer, stderr: "" }
        : answer
    },
    async sleep() {},
  }
}

const pr = (
  number: number,
  head: string,
  base: string,
  extra: Partial<OpenPr> = {},
): OpenPr => ({
  number,
  url: `https://github.com/acme/web/pull/${number}`,
  headRefName: head,
  baseRefName: base,
  isDraft: false,
  ...extra,
})

/** `gh` answering `pr list` from these open pull requests, and nothing merged. */
function listing(prs: OpenPr[], more: Gh = () => undefined): Gh {
  return (args) => {
    const answer = more(args)
    if (answer !== undefined) {
      return answer
    }
    if (args[0] === "pr" && args[1] === "list") {
      const flag = (name: string) => {
        const i = args.indexOf(name)
        return i < 0 ? undefined : args[i + 1]
      }
      if (flag("--state") === "merged") {
        return "[]"
      }
      return JSON.stringify(
        prs.filter(
          (p) =>
            (!flag("--head") || p.headRefName === flag("--head")) &&
            (!flag("--base") || p.baseRefName === flag("--base")),
        ),
      )
    }
    return undefined
  }
}

const ctxOf = (sh: Shell, base = "main"): StackContext => ({
  sh,
  repo: "acme/web",
  base,
})

/** main ← p (pushed) ← c (pushed), checked out on c. */
function stackOfTwo(): void {
  git(work, "switch", "-q", "-c", "p")
  commit(work, "p.txt", "p\n", "p1")
  git(work, "push", "-q", "-u", "origin", "p")
  git(work, "switch", "-q", "-c", "c")
  commit(work, "c.txt", "c\n", "c1")
  git(work, "push", "-q", "-u", "origin", "c")
}

describe("parent", () => {
  it("reads the recorded parent first, for any branch name", () => {
    git(work, "config", "branch.feat/x.y.stackParent", "base/one")
    git(work, "config", "branch.other.stackParent", "feat/x.y")
    const sh = fakeShell(work, listing([]))
    expect(recordedParents(sh)).toEqual(
      new Map([
        ["feat/x.y", "base/one"],
        ["other", "feat/x.y"],
      ]),
    )
    expect(findParent(ctxOf(sh), "other")).toEqual({
      parent: "feat/x.y",
      source: "recorded",
    })
    // The record answers without asking the host.
    expect(sh.calls).toEqual([])
  })

  it("takes the pull request's base only when that base is a stacked branch", () => {
    const prs = [pr(1, "p", "main"), pr(2, "c", "p"), pr(3, "wrong", "release")]
    const sh = fakeShell(work, listing(prs))
    expect(findParent(ctxOf(sh), "c")).toEqual({
      parent: "p",
      source: "pull request",
    })
    // On the base, and against a branch nothing stacks on (opened by hand
    // against the host's default branch): not stacked.
    expect(findParent(ctxOf(sh), "p")).toBeUndefined()
    expect(findParent(ctxOf(sh), "wrong")).toBeUndefined()
  })

  it("keeps a parent whose pull request merged, so sync sees it landed", () => {
    const sh = fakeShell(
      work,
      listing([pr(2, "c", "p")], (args) =>
        args.includes("merged") && args.includes("p")
          ? JSON.stringify([{ number: 1 }])
          : undefined,
      ),
    )
    expect(findParent(ctxOf(sh), "c")?.parent).toBe("p")
  })

  it("fails closed when the host can't be read", () => {
    const sh = fakeShell(work, () => ({
      status: 1,
      stdout: "",
      stderr: "HTTP 502",
    }))
    expect(() => findParent(ctxOf(sh), "c")).toThrow(/HTTP 502/)
  })

  it("infers a new branch's parent from the branch it was created from", async () => {
    stackOfTwo()
    git(work, "switch", "-q", "p")
    git(work, "switch", "-q", "-c", "c2")
    git(work, "branch", "c3", "origin/p")
    git(work, "switch", "-q", "main")
    git(work, "switch", "-q", "-c", "plain")
    const sh = fakeShell(work, listing([pr(1, "p", "main")]))
    expect(createdFrom(sh, "c2")).toBe("p")
    expect(createdFrom(sh, "c3")).toBe("p")
    expect(createdFrom(sh, "plain")).toBe("main")
    // Created from the base: not stacked.
    await expect(parentOp(ctxOf(sh))).rejects.toThrow(/plain isn't stacked/)
    git(work, "switch", "-q", "c2")
    expect(await parentOp(ctxOf(sh))).toEqual({
      parent: "p",
      source: "created from",
    })
  })

  it("track records a stacked parent, clears it for the base, and refuses any other", async () => {
    git(work, "switch", "-q", "-c", "c")
    const sh = fakeShell(work, listing([pr(1, "p", "main")]))
    await expect(trackOp(ctxOf(sh), "release")).rejects.toThrow(
      /release isn't a stacked branch/,
    )
    expect(recordedParents(sh).has("c")).toBe(false)
    expect(await trackOp(ctxOf(sh), "p")).toEqual({
      branch: "c",
      parent: "p",
      recorded: true,
    })
    expect(git(work, "config", "--get", "branch.c.stackParent")).toBe("p")
    expect(await trackOp(ctxOf(sh), "main")).toMatchObject({ recorded: false })
    expect(recordedParents(sh).has("c")).toBe(false)
  })
})

describe("downstack", () => {
  it("walks pull request bases down to the base and counts what's above", async () => {
    // main ← a ← b ← c, with d on a and e on c; x stands alone.
    const prs = [
      pr(1, "a", "main"),
      pr(2, "b", "a"),
      pr(3, "c", "b"),
      pr(4, "d", "a"),
      pr(5, "e", "c"),
      pr(6, "x", "main"),
    ]
    for (const branch of ["c", "a", "x"]) {
      git(work, "switch", "-q", "-C", branch, "main")
    }
    const sh = fakeShell(work, listing(prs))
    git(work, "switch", "-q", "c")
    expect(await downstackOp(ctxOf(sh))).toEqual({
      chain: ["a", "b", "c"],
      above: 1,
      size: 5,
    })
    git(work, "switch", "-q", "a")
    expect(await downstackOp(ctxOf(sh))).toEqual({
      chain: ["a"],
      above: 4,
      size: 5,
    })
    git(work, "switch", "-q", "x")
    expect(await downstackOp(ctxOf(sh))).toEqual({
      chain: ["x"],
      above: 0,
      size: 1,
    })
  })

  it("keeps a recorded parent whose pull request merged in the chain, so merge calls it stale", async () => {
    git(work, "switch", "-q", "-c", "c")
    git(work, "config", "branch.c.stackParent", "b")
    git(work, "config", "branch.b.stackParent", "a")
    const sh = fakeShell(work, listing([pr(1, "a", "main")]))
    expect((await downstackOp(ctxOf(sh))).chain).toEqual(["a", "b", "c"])
  })
})

describe("restack", () => {
  it("merges the parent in, keeping the branch's pushed commits", async () => {
    stackOfTwo()
    const before = git(work, "rev-parse", "HEAD")
    git(work, "switch", "-q", "p")
    commit(work, "p2.txt", "p2\n", "p2")
    git(work, "push", "-q", "origin", "p")
    git(work, "switch", "-q", "c")
    git(work, "branch", "-f", "p", "HEAD~1")
    const sh = fakeShell(work, listing([pr(1, "p", "main"), pr(2, "c", "p")]))
    expect(await restackOp(ctxOf(sh))).toEqual({
      branch: "c",
      parent: "p",
      merged: 1,
    })
    expect(
      spawnSync("git", ["merge-base", "--is-ancestor", before, "HEAD"], {
        cwd: work,
      }).status,
    ).toBe(0)
    expect(git(work, "rev-list", "--count", "HEAD..origin/p")).toBe("0")
    expect(await restackOp(ctxOf(sh))).toMatchObject({ merged: 0 })
  })

  it("catches an unstacked branch up to the base", async () => {
    git(work, "switch", "-q", "-c", "solo")
    commit(work, "solo.txt", "s\n", "solo")
    git(work, "switch", "-q", "main")
    commit(work, "more.txt", "m\n", "more")
    git(work, "push", "-q", "origin", "main")
    git(work, "switch", "-q", "solo")
    const sh = fakeShell(work, listing([]))
    expect(await restackOp(ctxOf(sh))).toMatchObject({
      parent: "main",
      merged: 1,
    })
  })

  it("stops on conflicts, saying how to carry on", async () => {
    stackOfTwo()
    commit(work, "p.txt", "c's\n", "c edits p.txt")
    git(work, "switch", "-q", "p")
    commit(work, "p.txt", "p's\n", "p edits p.txt")
    git(work, "push", "-q", "origin", "p")
    git(work, "switch", "-q", "c")
    const sh = fakeShell(work, listing([pr(1, "p", "main"), pr(2, "c", "p")]))
    await expect(restackOp(ctxOf(sh))).rejects.toThrow(/git commit --no-edit/)
  })
})

describe("reparent and submit", () => {
  /** p squash-merged into main on origin, c still on p. */
  function landParent(): { pTip: string; cRemote: string } {
    stackOfTwo()
    const pTip = git(work, "rev-parse", "origin/p")
    const cRemote = git(work, "rev-parse", "origin/c")
    git(work, "switch", "-q", "main")
    git(work, "merge", "-q", "--squash", "p")
    git(work, "commit", "-q", "-m", "p (#1)")
    git(work, "push", "-q", "origin", "main")
    git(work, "switch", "-q", "c")
    git(work, "config", "branch.c.stackParent", "p")
    return { pTip, cRemote }
  }

  it("moves only the branch's own commits onto the parent's base, then pushes over exactly the tip it replaced", async () => {
    const { pTip, cRemote } = landParent()
    let base = "p"
    const sh = fakeShell(work, (args) => {
      const line = args.join(" ")
      if (line.includes("--head p --state merged")) {
        return JSON.stringify([{ number: 1, headRefOid: pTip }])
      }
      if (line.includes("--state open --limit 1000 --json")) {
        return JSON.stringify([pr(2, "c", base)])
      }
      if (line.includes("--head c --state open")) {
        return JSON.stringify([pr(2, "c", base)])
      }
      if (line === "pr edit 2 --repo acme/web --base main") {
        base = "main"
        return ""
      }
      return undefined
    })
    expect(await reparentOp(ctxOf(sh), "p", "main")).toMatchObject({
      branch: "c",
      onto: "main",
      from: pTip,
      retargeted: true,
    })
    expect(git(work, "log", "--format=%s", "origin/main..HEAD")).toBe("c1")
    expect(recordedParents(sh).has("c")).toBe(false)
    expect(git(work, "config", "--get", "branch.c.stackLease")).toBe(cRemote)

    expect(await submitOp(ctxOf(sh))).toMatchObject({
      parent: "main",
      url: "https://github.com/acme/web/pull/2",
      created: false,
      retargeted: false,
      forced: true,
    })
    expect(git(work, "rev-parse", "origin/c")).toBe(
      git(work, "rev-parse", "HEAD"),
    )
    expect(
      spawnSync("git", ["config", "--get", "branch.c.stackLease"], {
        cwd: work,
      }).status,
    ).not.toBe(0)
  })

  it("refuses to move a branch whose remote has commits this checkout lacks", async () => {
    const { pTip } = landParent()
    const other = clone("other")
    git(other, "switch", "-q", "c")
    commit(other, "late.txt", "late\n", "pushed from elsewhere")
    git(other, "push", "-q", "origin", "c")
    const sh = fakeShell(work, (args) =>
      args.includes("merged")
        ? JSON.stringify([{ number: 1, headRefOid: pTip }])
        : "[]",
    )
    await expect(reparentOp(ctxOf(sh), "p", "main")).rejects.toThrow(
      /git merge origin\/c/,
    )
  })

  it("never forces a push that the remote refused without a reparent's lease", async () => {
    stackOfTwo()
    const other = clone("other")
    git(other, "switch", "-q", "c")
    commit(other, "late.txt", "late\n", "pushed from elsewhere")
    git(other, "push", "-q", "origin", "c")
    const remote = git(other, "rev-parse", "HEAD")
    commit(work, "mine.txt", "mine\n", "local work")
    const sh = fakeShell(work, listing([pr(1, "p", "main"), pr(2, "c", "p")]))
    await expect(submitOp(ctxOf(sh))).rejects.toThrow(/Never force-push/)
    git(work, "fetch", "-q", "origin", "c")
    expect(git(work, "rev-parse", "origin/c")).toBe(remote)
  })

  it("opens the draft pull request against the parent, and records it", async () => {
    stackOfTwo()
    git(work, "switch", "-q", "-c", "d")
    commit(work, "d.txt", "d\n", "d1")
    const sh = fakeShell(
      work,
      listing([pr(1, "p", "main"), pr(2, "c", "p")], (args) =>
        args[1] === "create"
          ? "Creating draft pull request\nhttps://github.com/acme/web/pull/3\n"
          : undefined,
      ),
    )
    expect(await submitOp(ctxOf(sh))).toMatchObject({
      parent: "c",
      url: "https://github.com/acme/web/pull/3",
      created: true,
    })
    expect(sh.calls).toContain(
      "pr create --repo acme/web --draft --base c --head d --fill",
    )
    expect(git(work, "config", "--get", "branch.d.stackParent")).toBe("c")
  })

  it("retargets an existing pull request whose base isn't the parent", async () => {
    stackOfTwo()
    git(work, "config", "branch.c.stackParent", "p")
    const sh = fakeShell(
      work,
      listing([pr(1, "p", "main"), pr(2, "c", "main")], (args) =>
        args[1] === "edit" ? "" : undefined,
      ),
    )
    expect(await submitOp(ctxOf(sh))).toMatchObject({ retargeted: true })
    expect(sh.calls).toContain("pr edit 2 --repo acme/web --base p")
  })
})

describe("mergeStack", () => {
  function hostFor(
    prs: OpenPr[],
    options: { conflict?: string } = {},
  ): { gh: Gh; merged: Set<number> } {
    const merged = new Set<number>()
    const views = new Map<number, number>()
    const gh: Gh = (args) => {
      const n = Number(args[2])
      const found = prs.find((p) => p.number === n)
      switch (`${args[0]} ${args[1]}`) {
        case "pr ready":
        case "pr edit":
          return ""
        case "pr view": {
          if (args.at(-1) === "state") {
            return JSON.stringify({ state: merged.has(n) ? "MERGED" : "OPEN" })
          }
          const seen = (views.get(n) ?? 0) + 1
          views.set(n, seen)
          return JSON.stringify({
            mergeable:
              seen === 1
                ? "UNKNOWN"
                : found?.headRefName === options.conflict
                  ? "CONFLICTING"
                  : "MERGEABLE",
            headRefOid: git(work, "rev-parse", `origin/${found?.headRefName}`),
          })
        }
        case "pr merge":
          merged.add(n)
          return ""
        case "api -X":
          return ""
      }
      return listing(prs.filter((p) => !merged.has(p.number)))(args)
    }
    return { gh, merged }
  }

  it("lands the chain bottom first with merge commits pinned to each head", async () => {
    stackOfTwo()
    const prs = [pr(1, "p", "main", { isDraft: true }), pr(2, "c", "p")]
    const { gh } = hostFor(prs)
    const sh = fakeShell(work, gh)
    const result = await mergeStackOp(ctxOf(sh))
    expect(result).toEqual({
      ok: true,
      method: "merge",
      merged: [
        { branch: "p", pr: 1 },
        { branch: "c", pr: 2 },
      ],
      remoteRefs: { p: "deleted" },
    })
    const pHead = git(work, "rev-parse", "origin/p")
    const writes = sh.calls.filter(
      (c) => !c.startsWith("pr list") && !c.startsWith("pr view"),
    )
    expect(writes).toEqual([
      "pr ready 1 --repo acme/web",
      `pr merge 1 --repo acme/web --merge --match-head-commit ${pHead}`,
      "pr edit 2 --repo acme/web --base main",
      `pr merge 2 --repo acme/web --merge --match-head-commit ${git(work, "rev-parse", "origin/c")}`,
      "api -X DELETE repos/acme/web/git/refs/heads/p",
    ])
  })

  it("stops at the first that can't merge, and says which merged", async () => {
    stackOfTwo()
    const { gh } = hostFor([pr(1, "p", "main"), pr(2, "c", "p")], {
      conflict: "c",
    })
    const result = await mergeStackOp(ctxOf(fakeShell(work, gh)))
    expect(result.ok).toBe(false)
    expect(result.merged).toEqual([{ branch: "p", pr: 1 }])
    expect(result.failure).toEqual({
      branch: "c",
      error:
        "#2 conflicts with main once retargeted: sync it, then merge again",
    })
  })

  it("refuses before merging anything when a branch isn't pushed as it is here", async () => {
    stackOfTwo()
    commit(work, "unpushed.txt", "u\n", "unpushed")
    const { gh, merged } = hostFor([pr(1, "p", "main"), pr(2, "c", "p")])
    await expect(mergeStackOp(ctxOf(fakeShell(work, gh)))).rejects.toThrow(
      /local branches differ from their remotes \(c\)/,
    )
    expect(merged.size).toBe(0)
  })
})

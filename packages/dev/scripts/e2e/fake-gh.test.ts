import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { loadState } from "./fake-gh.ts"

const GH = path.join(import.meta.dirname, "bin", "gh")
const ID = ["-c", "user.email=t@example.com", "-c", "user.name=t"]

describe("fake gh", () => {
  let dir: string
  let origin: string
  let work: string
  let env: NodeJS.ProcessEnv

  const git = (args: string[], cwd = work) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (r.status !== 0) throw new Error(r.stderr)
    return r.stdout.trim()
  }
  const gh = (...args: string[]) =>
    spawnSync(GH, args, { cwd: work, env, encoding: "utf8" })

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fake-gh-"))
    origin = path.join(dir, "origin.git")
    work = path.join(dir, "work")
    env = {
      ...process.env,
      FAKE_GH_STATE: path.join(dir, "state.json"),
      FAKE_GH_ORIGIN: origin,
    }
    git(["init", "-q", "--bare", "-b", "main", origin], dir)
    git(["clone", "-q", origin, work], dir)
    writeFileSync(path.join(work, "a.test.js"), 'import "node:test"\n')
    git(["add", "-A"])
    git([...ID, "commit", "-qm", "initial"])
    git(["push", "-q", "origin", "main"])
    git(["checkout", "-q", "-b", "feat"])
    writeFileSync(path.join(work, "b.txt"), "b\n")
    git(["add", "-A"])
    git([...ID, "commit", "-qm", "Add b"])
    git(["push", "-q", "-u", "origin", "feat"])
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("finds no pull request for a branch until one is opened", () => {
    const none = gh("pr", "view", "feat", "--json", "number")
    expect(none.status).toBe(1)
    expect(none.stderr).toContain("no pull requests found")
    const made = gh(
      "pr",
      "create",
      "--draft",
      "--base",
      "main",
      "--head",
      "feat",
      "--title",
      "B",
      "--body",
      "b",
    )
    expect(made.stdout.trim()).toBe("https://github.com/e2e-fake/app/pull/1")
    const view = JSON.parse(
      gh("pr", "view", "feat", "--json", "number,isDraft,mergeStateStatus")
        .stdout,
    )
    expect(view).toEqual({
      number: 1,
      isDraft: true,
      mergeStateStatus: "DRAFT",
    })
  })

  it("runs CI at the commit and reads it through --jq, one object a line", () => {
    const sha = git(["rev-parse", "HEAD"])
    const r = gh(
      "api",
      "--paginate",
      `repos/e2e-fake/app/commits/${sha}/check-runs?per_page=100`,
      "--jq",
      ".check_runs[] | {name, conclusion}",
    )
    expect(r.stdout).toBe('{"name":"test","conclusion":"success"}\n')
    const empty = gh(
      "api",
      "repos/e2e-fake/app/branches/main",
      "--jq",
      ".protection.required_status_checks.contexts[]?",
    )
    expect(empty.stdout).toBe("")
  })

  it("merges a ready pull request pinned to its head into the bare repo", () => {
    const sha = git(["rev-parse", "HEAD"])
    expect(gh("pr", "merge", "1", "--squash").stderr).toContain("draft")
    gh("pr", "ready", "1")
    expect(
      gh("pr", "merge", "1", "--squash", "--match-head-commit", "0000").stderr,
    ).toContain("Head branch was modified")
    const merged = gh(
      "pr",
      "merge",
      "1",
      "--squash",
      "--match-head-commit",
      sha,
    )
    expect(merged.status).toBe(0)
    expect(git(["--git-dir", origin, "log", "-1", "--format=%s", "main"])).toBe(
      "B (#1)",
    )
    const state = loadState(env.FAKE_GH_STATE ?? "")
    expect(state.prs[0]).toMatchObject({ state: "MERGED", isDraft: false })
  })

  it("fails loudly on a command it doesn't fake", () => {
    const r = gh("issue", "list")
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("unsupported command")
  })
})

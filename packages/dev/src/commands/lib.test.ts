import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { gitPath, requireGitPath, stateDir } from "./lib.ts"

describe("stateDir", () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lib-")))
  const main = path.join(tmp, "main")
  const linked = path.join(tmp, "linked")
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" })
  fs.mkdirSync(main)
  git(main, "init", "-q")
  git(
    main,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "x",
  )
  git(main, "worktree", "add", "-q", linked)
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("keeps each worktree's own files apart, and shared ones in the common dir", () => {
    const common = path.join(main, ".git", "agent-flows", "ready")
    expect(stateDir("ready", { cwd: main })).toBe(common)
    expect(stateDir("ready", { cwd: linked })).toBe(
      path.join(main, ".git", "worktrees", "linked", "agent-flows", "ready"),
    )
    expect(stateDir("ready", { cwd: linked, shared: true })).toBe(common)
  })

  it("has no git path outside a repo", () => {
    expect(gitPath("--show-toplevel", tmp)).toBeUndefined()
    expect(() => requireGitPath("--show-toplevel", tmp)).toThrow(
      "not inside a git repository",
    )
    expect(gitPath("--show-toplevel", linked)).toBe(linked)
  })
})

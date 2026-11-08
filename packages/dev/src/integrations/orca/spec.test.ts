import { describe, expect, it } from "vitest"
import type { DetectContext } from "../../config/types.ts"
import { worktreeDirectory } from "../worktree/spec.ts"
import { orca } from "./spec.ts"

const PORCELAIN = `worktree /Users/sam/code/web
HEAD 9cd963e
branch refs/heads/main

worktree /Users/sam/orca/workspaces/web/ruffe
HEAD 273bb26
branch refs/heads/sam/fix-login

worktree /Users/sam/orca/workspaces/web/heron
HEAD 41aa0c2
branch refs/heads/sam/add-search
`

function checkout(
  porcelain: string,
  env: Record<string, string> = {},
): DetectContext {
  return {
    env,
    git: (args: string[]) =>
      args.join(" ") === "worktree list --porcelain" ? porcelain : undefined,
  } as unknown as DetectContext
}

describe("orca", () => {
  it("detects the worktrees Orca checked out", () => {
    expect(orca.detect?.(checkout(PORCELAIN))).toEqual({
      values: {},
      evidence: ["2 git worktree(s) in Orca's default folder"],
    })
  })

  it("detects Orca from inside it, wherever its worktrees are", () => {
    expect(
      orca.detect?.(
        checkout("worktree /Users/sam/code/web\n", { ORCA_WORKTREE_ID: "x" }),
      ),
    ).toEqual({ values: {}, evidence: ["this session runs in Orca"] })
  })

  it("finds nothing in a repo Orca never touched", () => {
    expect(
      orca.detect?.(checkout("worktree /Users/sam/code/web\n")),
    ).toBeUndefined()
  })

  it("keeps Orca's worktrees out of the repo's own worktree directory", () => {
    expect(worktreeDirectory(PORCELAIN)).toBeUndefined()
  })
})

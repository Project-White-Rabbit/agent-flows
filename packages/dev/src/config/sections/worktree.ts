import path from "node:path"
import type { IntegrationSpec } from "../types.ts"
import { CONDUCTOR_WORKSPACES } from "./conductor.ts"
import { PATH, SLUG } from "./patterns.ts"
import { SUPERSET_WORKTREES } from "./superset.ts"

/** The `worktree <path>` lines of `git worktree list --porcelain`, main first. */
export function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
}

/**
 * Where the repo's own linked worktrees live, relative to the main checkout:
 * the directory most of them share, leaving out the ones a workspace app
 * checked out.
 */
export function worktreeDirectory(porcelain: string): string | undefined {
  const [main, ...linked] = worktreePaths(porcelain)
  const counts = new Map<string, number>()
  for (const worktree of linked) {
    if (
      worktree.includes(SUPERSET_WORKTREES) ||
      worktree.includes(CONDUCTOR_WORKSPACES)
    ) {
      continue
    }
    const parent = path.relative(main, path.dirname(worktree)) || "."
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  let best: string | undefined
  for (const [parent, hits] of counts) {
    if (!best || hits > (counts.get(best) ?? 0)) {
      best = parent
    }
  }
  return best && PATH.regex.test(best) ? best : undefined
}

export const worktree: IntegrationSpec = {
  path: "integrations.worktree",
  name: "Git worktrees",
  purpose:
    "Plain git worktrees, one per branch, for repos with no workspace app; the agent is started by hand",
  fields: [
    {
      key: "directory",
      description:
        "Where new worktrees go: a path relative to the main checkout, or absolute",
      example: "../web-worktrees",
      required: true,
      pattern: PATH,
    },
    {
      key: "agent",
      description:
        "Command that starts a coding agent on a prompt given as its argument",
      example: "claude",
      pattern: SLUG,
    },
  ],
  lookup:
    "The directory the repo's linked worktrees share (`git worktree list`), else ask; `../<repo>-worktrees` keeps them out of the checkout",
  access: { cli: { bin: "git" } },
  provides: {
    workspaces: {
      workspaces: {
        cli: "`git worktree list --porcelain`: one workspace per `worktree <path>` block with a `branch refs/heads/<branch>` line. Its id and name are the path, and it has no section. This session runs in the one whose path is `git rev-parse --show-toplevel`",
      },
      renameWorkspace:
        "Nothing to do: a git worktree is known by its path, which stays as it is, and has no name or section of its own",
      createWorkspace: {
        cli: "In the main checkout (the first `worktree` in `git worktree list --porcelain`), with <path> `{directory}/<branch>` with each `/` in the branch turned into `-`: when <exact> is `no`, first put <branch> under the prefix most of the person's own branches carry (`sam/` in `git for-each-ref --format='%(refname:short)' refs/heads`), when they carry one. Then `git fetch origin`, and `git worktree add <path> <branch>` when the branch exists, else `git worktree add -b <branch> <path> origin/<base>`. Sections don't apply. Git can't start an agent, so print `cd <path> && {agent|claude} \"$(cat <prompt-file>)\"` for the person to run. Prints <path> and the branch",
      },
    },
  },
  detect(ctx) {
    const directory = worktreeDirectory(
      ctx.git(["worktree", "list", "--porcelain"]) ?? "",
    )
    return directory
      ? {
          values: { directory },
          evidence: [`the repo's git worktrees live in ${directory}`],
        }
      : undefined
  },
}

import os from "node:os"
import path from "node:path"
import { homePathWarning } from "../../config/personal.ts"
import type { IntegrationSpec } from "../../config/types.ts"
import { CONDUCTOR_WORKSPACES } from "../conductor/spec.ts"
import { ORCA_WORKSPACES } from "../orca/spec.ts"
import { PATH, SLUG } from "../patterns.ts"
import { SUPERSET_WORKTREES } from "../superset/spec.ts"

/** The `worktree <path>` lines of `git worktree list --porcelain`, main first. */
export function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
}

/**
 * A worktree directory as every teammate can use it: relative to the main
 * checkout when it's inside it or beside it (`../web-worktrees`), else from
 * the home folder (`~/worktrees/web`), else none, since an absolute path
 * elsewhere, or one climbing out past the checkout's own folder, depends on
 * where this person keeps things.
 */
export function portableDirectory(
  main: string,
  dir: string,
  home: string,
): string | undefined {
  const relative = path.relative(main, dir) || "."
  const climbs = relative.split(path.sep).filter((part) => part === "..")
  if (!path.isAbsolute(relative) && climbs.length <= 1) {
    return relative
  }
  const fromHome = path.relative(home, dir)
  return fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)
    ? `~/${fromHome}`
    : undefined
}

/** Why a committed `directory` only works on one person's machine. */
function directoryWarning(value: unknown): string | undefined {
  const text = String(value)
  const home = homePathWarning(text)
  if (home) {
    return home
  }
  if (path.isAbsolute(text)) {
    return "is an absolute path, which may not exist on teammates' machines: use a path relative to the main checkout (`../web-worktrees`) or `~/…`, or put it in this machine's override (`configure local`)"
  }
  return text.split("/").filter((part) => part === "..").length > 1
    ? "climbs out past the main checkout's own folder, so it depends on where each person cloned the repo: use `../<name>` or `~/…`, or put it in this machine's override (`configure local`)"
    : undefined
}

/**
 * Where the repo's own linked worktrees live, as `portableDirectory` gives
 * it: the directory most of them share, leaving out the ones a workspace app
 * checked out.
 */
export function worktreeDirectory(
  porcelain: string,
  home = os.homedir(),
): string | undefined {
  const [main, ...linked] = worktreePaths(porcelain)
  const counts = new Map<string, number>()
  for (const worktree of linked) {
    if (
      SUPERSET_WORKTREES.some((part) => worktree.includes(part)) ||
      worktree.includes(CONDUCTOR_WORKSPACES) ||
      worktree.includes(ORCA_WORKSPACES)
    ) {
      continue
    }
    const parent = path.dirname(worktree)
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  let best: string | undefined
  for (const [parent, hits] of counts) {
    if (!best || hits > (counts.get(best) ?? 0)) {
      best = parent
    }
  }
  const portable = best && portableDirectory(main, best, home)
  return portable && PATH.regex.test(portable) ? portable : undefined
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
        "Where new worktrees go: a path relative to the main checkout (beside it, like `../web-worktrees`, or inside it), or from the home folder (`~/worktrees/web`), so it works wherever each teammate cloned the repo",
      example: "../web-worktrees",
      required: true,
      pattern: PATH,
      warn: directoryWarning,
    },
    {
      key: "agent",
      description:
        "Command that starts a coding agent on a prompt given as its argument: the team's default, only when the team agreed on one. Each person's own choice goes in this machine's override (`configure local`)",
      example: "claude",
      pattern: SLUG,
    },
  ],
  lookup:
    "The directory the repo's linked worktrees share (`git worktree list`), as a path relative to the main checkout or from `~`, never one in a person's home folder by name; else ask. `../<repo>-worktrees` keeps them out of the checkout",
  access: { cli: { bin: "git" } },
  provides: {
    workspaces: {
      workspaces: {
        cli: "`git worktree list --porcelain` (with <repository>, a path to another repository's checkout, `git -C <repository> worktree list --porcelain`): one workspace per `worktree <path>` block with a `branch refs/heads/<branch>` line. Its id and name are the path, and it has no section. This session runs in the one whose path is `git rev-parse --show-toplevel`",
      },
      renameWorkspace:
        "Nothing to do: a git worktree is known by its path, which stays as it is, and has no name or section of its own",
      createWorkspace: {
        cli: "With <repository>, a path to another repository's checkout, run everything below there (`git -C <repository>`), and <base> is its default branch (`git -C <repository> symbolic-ref --short refs/remotes/origin/HEAD`, without the `origin/`). In the main checkout (the first `worktree` in `git worktree list --porcelain`), with <path> `{directory}/<branch>` with each `/` in the branch turned into `-`: when <exact> is `no`, first put <branch> under the prefix most of the person's own branches carry (`sam/` in `git for-each-ref --format='%(refname:short)' refs/heads`), when they carry one. Then `git fetch origin`, and `git worktree add <path> <branch>` when the branch exists, else `git worktree add -b <branch> <path> origin/<base>`. Sections don't apply. Git can't start an agent, so print `cd <path> && {agent|claude} \"$(cat <prompt-file>)\"` for the person to run. Prints <path> and the branch",
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

import type { IntegrationSpec } from "../../config/types.ts"
import { SLUG } from "../patterns.ts"

/**
 * Where Orca checks out its worktrees by default (`~/orca/workspaces/<repo>/`).
 * People can move them (its `workspaceDir` setting, or a repo's `worktreeBasePath`), so this is only a
 * clue.
 */
export const ORCA_WORKSPACES = "/orca/workspaces/"

/**
 * Set in every Orca terminal pane, to its worktree's `<repo id>::<path>` id
 * (`global-floating-terminal` in the floating one, which is still Orca).
 */
const ORCA_ENV = "ORCA_WORKTREE_ID"

/**
 * Whether `orca worktree current --json` found a linked worktree. Not the
 * main checkout: Orca counts a registered repo's main checkout as one of its
 * worktrees, and other apps may list it too.
 */
export function inLinkedWorktree(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: { worktree?: { isMainWorktree?: unknown } }
    }
    return parsed.result?.worktree?.isMainWorktree === false
  } catch {
    return false
  }
}

// Orca has no sign-in of its own: its CLI talks to the local Orca app, which
// `orca status` reports on. It has no sidebar sections either (its board
// columns are statuses, not places to file a workspace).
export const orca: IntegrationSpec = {
  path: "integrations.orca",
  name: "Orca",
  purpose:
    "Local workspaces, each a worktree with a coding agent working in it",
  fields: [
    {
      key: "repo",
      description: "Orca repo id for this repository",
      example: "66ee3232-21c9-46d7-bd8e-0adf8e9bed5c",
      required: true,
      pattern: SLUG,
    },
    {
      key: "agent",
      description: "Agent new workspaces start (claude, codex, …)",
      example: "claude",
      pattern: SLUG,
    },
  ],
  lookup:
    "`orca repo list --json`: the entry of `result.repos` whose `path` is this repository's main checkout, or whose `gitRemoteIdentity.remoteUrl` is its origin. The Orca app must be running (`orca open` starts it)",
  access: { cli: { bin: "orca" } },
  // `worktree current` exits 0 only in a worktree Orca manages.
  session: {
    env: [ORCA_ENV],
    check: {
      command: ["orca", "worktree", "current", "--json"],
      matches: inLinkedWorktree,
    },
  },
  provides: {
    workspaces: {
      workspaces: {
        cli: "`orca worktree list --json --repo id:{repo} --limit 1000` (with <repository>, `id:<that repo's id>`, as for `createWorkspace`), keeping the entries of `result.worktrees` whose `isArchived` is false. Each one's id is its `id` (the whole `<repo id>::<path>` value), its name its `displayName`, its branch its `branch` without `refs/heads/`, and it has no section. This session runs in the one whose `id` is `$ORCA_WORKTREE_ID`, or, with that unset, whose `path` is `git rev-parse --show-toplevel`",
      },
      renameWorkspace: {
        cli: "`orca worktree set --json --worktree id:<id> --display-name <name>`. Orca has no sidebar sections, so a <section> doesn't apply: say so when one is given",
      },
      createWorkspace: {
        cli: "With <repository>, in place of `{repo}` the `id` of the entry of `orca repo list --json` whose `displayName` or `id` is <repository> (none: say so, listing the names, and open nothing), and for <base> that repo's default branch, from `git -C <its path> symbolic-ref --short refs/remotes/origin/HEAD` without the `origin/`. Orca has no sidebar sections, so a <section> doesn't apply: say so when one is given. When <exact> is `no`, first put <branch> under the prefix most of the person's own branches carry (`sam/` in `git for-each-ref --format='%(refname:short)' refs/heads`), when they carry one. Then `git fetch origin`. When <branch> doesn't exist yet (locally or on origin): `orca worktree create --json --repo id:{repo} --no-parent --name <name> --branch <branch> --base-branch origin/<base> --agent {agent|claude} --prompt \"$(cat <prompt-file>)\"`; its JSON `result` holds the new worktree's `id`, `path`, and `branch` (Orca adds `-2`, `-3`, … when the name is taken, so report the branch it gives). When <branch> exists, Orca's CLI can't open it (it makes `<branch>-2` instead), so check it out yourself: `git worktree add <path> <branch>` from the main checkout, with <path> next to this repo's other Orca worktrees (in the folder holding the `path` of the entries of `orca worktree list --json --repo id:{repo}` whose `isMainWorktree` is false; with none, the repo's `worktreeBasePath` in `orca repo list --json` when it has one, else `~/orca/workspaces/<repo name>/`, Orca's default) named after the branch with each `/` turned into `-`; then `orca worktree set --json --worktree path:<path> --display-name <name>` and `orca agent launch --json --worktree path:<path> --agent {agent|claude} --prompt \"$(cat <prompt-file>)\"`. When Orca doesn't list that path (`selector_not_found`: a repo can hide worktrees Orca didn't make), print `cd <path> && {agent|claude} \"$(cat <prompt-file>)\"` for the person to run. Prints the workspace's id (or path), its branch, and its path",
      },
    },
  },
  detect(ctx) {
    const worktrees = ctx.git(["worktree", "list", "--porcelain"]) ?? ""
    const count = worktrees
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("worktree ") && line.includes(ORCA_WORKSPACES),
      ).length
    const evidence = [
      ...(ctx.env[ORCA_ENV] ? ["this session runs in Orca"] : []),
      ...(count > 0
        ? [`${count} git worktree(s) in Orca's default folder`]
        : []),
    ]
    return evidence.length > 0 ? { values: {}, evidence } : undefined
  },
}

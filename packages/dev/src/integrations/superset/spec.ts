import type { IntegrationSpec } from "../../config/types.ts"
import { SLUG } from "../patterns.ts"

/**
 * Where Superset checks out its workspaces by default: `~/.superset/worktrees/`,
 * or `~/.paradev/worktrees/` since it became Paradev. People can move them
 * (its `worktreeBaseDir` setting, or a project's own), so this is only a clue.
 */
export const SUPERSET_WORKTREES = [
  "/.superset/worktrees/",
  "/.paradev/worktrees/",
]

/** Set in Superset's terminals. */
const SUPERSET_ENV = "SUPERSET_WORKSPACE_ID"

/**
 * Whether `superset ws list --json` output has a worktree workspace checked
 * out at `root`. Not a `local` one: that's a repo's main checkout, which other
 * apps may list too, so it says nothing about which app this session is in.
 */
export function hasWorktree(stdout: string, root: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout)
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { workspaces?: unknown[] })?.workspaces ?? [])
    return list.some((ws) => {
      const { worktreePath, type } = ws as Record<string, unknown>
      return worktreePath === root && type !== "local"
    })
  } catch {
    return false
  }
}

export const superset: IntegrationSpec = {
  path: "integrations.superset",
  name: "Superset",
  purpose:
    "Local workspaces, each a worktree with a coding agent working in it",
  fields: [
    {
      key: "project",
      description: "Superset project id for this repository",
      example: "a10b8f37-f18e-4605-b7d5-764e5d661184",
      required: true,
      pattern: SLUG,
    },
    {
      key: "agent",
      description: "Agent preset new workspaces start (claude, codex, …)",
      example: "claude",
      pattern: SLUG,
    },
  ],
  lookup:
    "`superset projects list --local --json`: the project whose `repo` is this repository's origin, or whose `path` is its main checkout",
  access: { cli: { bin: "superset", auth: ["superset", "auth", "whoami"] } },
  session: {
    env: [SUPERSET_ENV],
    check: {
      command: ["superset", "ws", "list", "--local", "--json"],
      matches: hasWorktree,
    },
  },
  provides: {
    browser: {},
    workspaces: {
      workspaces: {
        cli: "`superset ws list --local --json`, keeping the ones with `projectId` `{project}` (with <repository>, that project's `id`, as for `createWorkspace`) and no `archivedAt`. Each has `id`, `name`, `branch`, and `tags` (its sidebar section, empty for none). This session runs in the one whose `id` is `$SUPERSET_WORKSPACE_ID`, or, with that unset, whose `worktreePath` is `git rev-parse --show-toplevel`",
      },
      renameWorkspace: {
        cli: "`superset ws update <id> --local --json --name <name>`, adding `--tag <section>` for a section or `--clear-tags` for `none` (a tag files the workspace in the sidebar section of that name, making it)",
      },
      createWorkspace: {
        cli: "`superset ws create --local --json --project {project} --name <name> --branch <branch> --base-branch <base> --agent {agent|claude} --prompt \"$(cat <prompt-file>)\"`. With <repository>, pass in place of `{project}` the `id` of the project in `superset projects list --local --json` whose `name` or `id` is <repository> (none: say so, listing the names, and open nothing), and for <base> that project's default branch, from `git -C <its path> symbolic-ref --short refs/remotes/origin/HEAD` without the `origin/`. Add `--skip-branch-prefix` when <exact> is `yes` (otherwise the branch goes under the project's branch prefix) and `--tag <section>` when a section is given (a tag files the workspace in the sidebar section of that name, making it). It prints JSON whose `workspace` (or the top level) has `id`, `branch`, and `worktreePath`",
      },
    },
  },
  detect(ctx) {
    const worktrees = ctx.git(["worktree", "list", "--porcelain"]) ?? ""
    const count = worktrees
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("worktree ") &&
          SUPERSET_WORKTREES.some((part) => line.includes(part)),
      ).length
    const evidence = [
      ...(ctx.env[SUPERSET_ENV] ? ["this session runs in Superset"] : []),
      ...(count > 0
        ? [`${count} git worktree(s) in Superset's default folder`]
        : []),
    ]
    return evidence.length > 0 ? { values: {}, evidence } : undefined
  },
}

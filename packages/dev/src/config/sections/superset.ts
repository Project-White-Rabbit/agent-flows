import type { IntegrationSpec } from "../types.ts"
import { SLUG } from "./patterns.ts"

/** Where Superset checks out its workspaces. */
export const SUPERSET_WORKTREES = "/.superset/worktrees/"

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
  provides: {
    workspaces: {
      workspaces: {
        cli: "`superset ws list --local --json`, keeping the ones with `projectId` `{project}` (with <project>, that project's `id`, as for `createWorkspace`) and no `archivedAt`. Each has `id`, `name`, `branch`, and `tags` (its sidebar section, empty for none). This session runs in the one whose `id` is `$SUPERSET_WORKSPACE_ID`",
      },
      renameWorkspace: {
        cli: "`superset ws update <id> --local --json --name <name>`, adding `--tag <section>` for a section or `--clear-tags` for `none` (a tag files the workspace in the sidebar section of that name, making it)",
      },
      createWorkspace: {
        cli: "`superset ws create --local --json --project {project} --name <name> --branch <branch> --base-branch <base> --agent {agent|claude} --prompt \"$(cat <prompt-file>)\"`. With <project>, pass in place of `{project}` the `id` of the project in `superset projects list --local --json` whose `name` or `id` is <project> (none: say so, listing the names, and open nothing), and for <base> that project's default branch, from `git -C <its path> symbolic-ref --short refs/remotes/origin/HEAD` without the `origin/`. Add `--skip-branch-prefix` when <exact> is `yes` (otherwise the branch goes under the project's branch prefix) and `--tag <section>` when a section is given (a tag files the workspace in the sidebar section of that name, making it). It prints JSON whose `workspace` (or the top level) has `id`, `branch`, and `worktreePath`",
      },
    },
  },
  detect(ctx) {
    const worktrees = ctx.git(["worktree", "list", "--porcelain"]) ?? ""
    const count = worktrees
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("worktree ") && line.includes(SUPERSET_WORKTREES),
      ).length
    return count > 0
      ? {
          values: {},
          evidence: [`${count} git worktree(s) checked out by Superset`],
        }
      : undefined
  },
}

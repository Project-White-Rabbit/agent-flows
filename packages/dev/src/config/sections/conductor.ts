import type { IntegrationSpec } from "../types.ts"
import { SLUG } from "./patterns.ts"

/** Where Conductor checks out its local workspaces. */
export const CONDUCTOR_WORKSPACES = "/conductor/workspaces/"

// Conductor's CLI drives cloud workspaces only: local ones open from its app,
// with no CLI or API for them.
export const conductor: IntegrationSpec = {
  path: "integrations.conductor",
  name: "Conductor",
  purpose: "Cloud workspaces, each a sandbox with a coding agent working in it",
  fields: [
    {
      key: "projectId",
      description: "Conductor project id for this repository",
      example: "proj_4f9a2c",
      required: true,
      pattern: SLUG,
    },
    {
      key: "agent",
      description: "Agent new workspaces start (claude, codex, cursor)",
      example: "claude",
      pattern: SLUG,
    },
  ],
  lookup:
    "`conductor project list --json`: the project for this repository. Outside a Conductor workspace the CLI may not be on PATH: the app keeps it at `~/Library/Application Support/com.conductor.app/bin/conductor`",
  access: {
    cli: { bin: "conductor", auth: ["conductor", "auth", "whoami"] },
  },
  provides: {
    workspaces: {
      workspaces: {
        cli: "`conductor project workspace {projectId} --json --limit 100` (with <project>, that project's id, as for `createWorkspace`), stepping `--offset` while the response reports `hasMore`: each workspace's id, name, branch, and section. This session runs in the one whose id is `$CONDUCTOR_WORKSPACE_ID`",
      },
      renameWorkspace: {
        cli: "`conductor workspace rename <id> --name <name>`. For a <section>, find or make it as for `createWorkspace`, then `conductor workspace move <id> --section <section id>`; Conductor can't take a workspace out of every section, so for `none` leave it and say so",
      },
      createWorkspace: {
        cli: "With <project>, in place of `{projectId}` the id of the project `conductor project list --json` names <project> (none: say so, listing the names, and open nothing). `conductor workspace create --json --project-id {projectId} --name <name> --session-name <name> --agent {agent|claude} --message-file <prompt-file>`, which opens a cloud workspace: Conductor's CLI can't open local ones, which open only from its app. Conductor names the new branch itself, so <branch> is only a suggestion, except that with <exact> `yes` add `--branch <branch>` to start from that branch. For a <section>, find its id by name in `conductor section list --json`, else make it with `conductor section create <section> --json`, then `conductor workspace move <workspace id> --section <section id>`. It prints the workspace's id, its branch, and a deep link to open it",
      },
    },
  },
  detect(ctx) {
    const evidence = [".conductor/settings.toml", "conductor.json"]
      .filter((file) => ctx.tracked.includes(file))
      .map((file) => `${file} is tracked`)
    const worktrees = ctx.git(["worktree", "list", "--porcelain"]) ?? ""
    if (worktrees.includes(CONDUCTOR_WORKSPACES)) {
      evidence.push("git worktrees checked out by Conductor")
    }
    return evidence.length > 0 ? { values: {}, evidence } : undefined
  },
}

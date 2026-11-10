import type {
  IntegrationSpec,
  MachineValues,
  SessionContext,
} from "../../config/types.ts"
import {
  type Checkout,
  checkoutOf,
  pickEntry,
  remoteKey,
  where,
} from "../local-repo.ts"
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

type SupersetProject = {
  id?: unknown
  name?: unknown
  path?: unknown
  repo?: unknown
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

/**
 * This repository's project in `superset projects list --local --json`
 * output, or why there's none.
 */
export function supersetProjectIn(
  stdout: string,
  checkout: Checkout,
): MachineValues {
  let projects: SupersetProject[]
  try {
    const parsed: unknown = JSON.parse(stdout)
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { projects?: unknown })?.projects
    projects = Array.isArray(list) ? (list as SupersetProject[]) : []
  } catch {
    return {
      problem:
        "`superset projects list --local --json` printed something other than JSON.",
    }
  }
  const found = pickEntry(
    // Ids land in shell commands: only ones a config field would allow.
    projects.filter((p) => SLUG.regex.test(text(p.id) ?? "")),
    checkout,
    {
      pathOf: (p) => text(p.path),
      keysOf: (p) => [remoteKey(text(p.repo))],
    },
  )
  if ("entry" in found) {
    return { values: { project: text(found.entry.id) as string } }
  }
  const at = where(checkout)
  if ("ambiguous" in found) {
    const listed = found.ambiguous
      .map((p) => `${text(p.name) ?? text(p.id)} (${text(p.path)})`)
      .join(", ")
    return {
      problem: `Superset has several projects on this machine for this repository's origin, none at ${at}: ${listed}. Remove the extra ones, or set this checkout up with \`superset projects setup <project id> --local --import ${at}\`.`,
    }
  }
  return {
    problem: `Superset has no project for this repository (${at}) on this machine. Adopt your team's with \`superset projects setup <project id> --local --import ${at}\`, or add one with \`superset projects create --local --import ${at}\` (or from Superset's app), then run this again.`,
  }
}

/**
 * Which Superset project this checkout is, on this machine: the one whose
 * `path` is the main checkout, else the one whose `repo` is origin. Never
 * sets one up.
 */
export async function supersetProject(
  session: SessionContext,
): Promise<MachineValues> {
  const checkout = await checkoutOf(session)
  const out = await session.run(
    ["superset", "projects", "list", "--local", "--json"],
    session.root,
  )
  return out === undefined
    ? {
        problem:
          "Couldn't list Superset's projects (`superset projects list --local --json` failed). Superset must be running and signed in: check `superset auth whoami`.",
      }
    : supersetProjectIn(out, checkout)
}

export const superset: IntegrationSpec = {
  path: "integrations.superset",
  name: "Superset",
  purpose:
    "Local workspaces, each a worktree with a coding agent working in it",
  fields: [
    {
      key: "agent",
      description:
        "Agent preset new workspaces start (claude, codex, …): the team's default, only when the team agreed on one. Each person's own choice goes in this machine's override (`configure local`)",
      example: "claude",
      pattern: SLUG,
    },
  ],
  // A Superset project belongs to one Superset organization, and each machine
  // sets it up at its own path, so the id isn't the team's: flows find it
  // where they run (`{project}`) rather than the config holding one person's.
  lookup:
    "Nothing to record: flows find this repository's Superset project on each machine. Check `superset projects list --local --json` has a project whose `path` is this repository's main checkout or whose `repo` is its origin; when none has, say Superset has no project for it here and suggest `superset projects setup <project id> --local --import <main checkout>` (or `superset projects create --local --import <main checkout>`) (never set one up yourself)",
  access: { cli: { bin: "superset", auth: ["superset", "auth", "whoami"] } },
  machine: { keys: ["project"], resolve: supersetProject },
  session: {
    env: [SUPERSET_ENV],
    check: {
      command: ["superset", "ws", "list", "--local", "--json"],
      matches: hasWorktree,
    },
  },
  provides: {
    browser: {
      openUrl: {
        cli: "`superset browser open --workspace <workspace> --url <url> --show --json`: it opens <url> in the workspace's browser pane (making one when there's none) and shows the workspace. It prints the pane's id",
      },
    },
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

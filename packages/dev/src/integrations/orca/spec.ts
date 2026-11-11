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
  samePath,
  where,
} from "../local-repo.ts"
import { BROWSER_PLACEMENT, SLUG } from "../patterns.ts"

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

type OrcaRepo = {
  id?: unknown
  path?: unknown
  displayName?: unknown
  gitRemoteIdentity?: { canonicalKey?: unknown; remoteUrl?: unknown }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

/**
 * The repo id in `$ORCA_WORKTREE_ID` (`<repo id>::<path>`), when that pane is
 * this checkout or its main one. A pane of another repo (the agent `cd`'d out
 * of it) or the floating terminal names no repo of this one.
 */
export function paneRepo(
  value: string | undefined,
  checkout: Checkout,
): string | undefined {
  const at = value?.indexOf("::") ?? -1
  if (!value || at <= 0) {
    return undefined
  }
  const id = value.slice(0, at)
  const pane = value.slice(at + 2)
  return SLUG.regex.test(id) &&
    (samePath(pane, checkout.root) || samePath(pane, checkout.main))
    ? id
    : undefined
}

/**
 * This repository's entry in `orca repo list --json` output, as a `--repo`
 * selector, or why there's none.
 */
export function orcaRepoIn(stdout: string, checkout: Checkout): MachineValues {
  let repos: OrcaRepo[]
  try {
    const parsed = JSON.parse(stdout) as { result?: { repos?: unknown } }
    const list = parsed.result?.repos
    repos = Array.isArray(list) ? (list as OrcaRepo[]) : []
  } catch {
    return {
      problem: "`orca repo list --json` printed something other than JSON.",
    }
  }
  const found = pickEntry(
    // Ids land in shell commands: only ones a config field would allow.
    repos.filter((r) => SLUG.regex.test(text(r.id) ?? "")),
    checkout,
    {
      pathOf: (r) => text(r.path),
      keysOf: (r) => [
        text(r.gitRemoteIdentity?.canonicalKey),
        remoteKey(text(r.gitRemoteIdentity?.remoteUrl)),
      ],
    },
  )
  if ("entry" in found) {
    return { values: { repo: `id:${text(found.entry.id)}` } }
  }
  if ("ambiguous" in found) {
    const listed = found.ambiguous
      .map((r) => `${text(r.displayName) ?? text(r.id)} (${text(r.path)})`)
      .join(", ")
    return {
      problem: `Orca has several repos for this repository's origin, none at ${where(checkout)}: ${listed}. Remove the extra ones from Orca, or add this checkout with \`orca repo add --path ${where(checkout)}\`.`,
    }
  }
  return {
    problem: `Orca hasn't added this repository (${where(checkout)}), so it has no workspaces for it. Add it with \`orca repo add --path ${where(checkout)}\` (or from Orca's app), then run this again.`,
  }
}

/**
 * Which Orca repo this checkout is, on this machine: the pane's own repo when
 * the session runs in Orca, else the entry Orca lists at the main checkout,
 * else the one whose remote is origin. Never adds it to Orca.
 */
export async function orcaRepo(
  session: SessionContext,
): Promise<MachineValues> {
  const checkout = await checkoutOf(session)
  const pane = paneRepo(session.env[ORCA_ENV], checkout)
  if (pane) {
    return { values: { repo: `id:${pane}` } }
  }
  const out = await session.run(
    ["orca", "repo", "list", "--json"],
    session.root,
  )
  return out === undefined
    ? {
        problem:
          "Couldn't list Orca's repos (`orca repo list --json` failed). Orca's app must be running: `orca open` starts it.",
      }
    : orcaRepoIn(out, checkout)
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
      key: "agent",
      description:
        "Agent new workspaces start (claude, codex, …): the team's default, only when the team agreed on one. Each person's own choice goes in this machine's override (`configure local`)",
      example: "claude",
      pattern: SLUG,
    },
    {
      key: "browser",
      description:
        "Where preview opens a page in Orca's browser: `tab` (a browser tab of its own, the default), or `right`, `left`, `down`, or `up` (split beside the agent's pane, on that side). A browser it reuses stays where it is. The team's default, only when the team agreed on one; each person's own choice goes in this machine's override (`configure local`)",
      example: "right",
      pattern: BROWSER_PLACEMENT,
    },
  ],
  // Orca's id for the repo is made by each machine's app, so flows find it
  // where they run (`{repo}`, an `id:` selector) rather than the config
  // holding one person's.
  lookup:
    "Nothing to record: flows find this repository in Orca on each machine. Check `orca repo list --json` has an entry of `result.repos` whose `path` is this repository's main checkout or whose `gitRemoteIdentity.canonicalKey` is its origin (`github.com/<owner>/<repo>`); when none has, say Orca hasn't added it and suggest `orca repo add --path <main checkout>` (never add it yourself). The Orca app must be running (`orca open` starts it)",
  access: { cli: { bin: "orca" } },
  machine: { keys: ["repo"], resolve: orcaRepo },
  // `worktree current` exits 0 only in a worktree Orca manages.
  session: {
    env: [ORCA_ENV],
    check: {
      command: ["orca", "worktree", "current", "--json"],
      matches: inLinkedWorktree,
    },
  },
  provides: {
    browser: {
      openUrl: {
        cli: "Placement `{browser|tab}`. `orca tab list --worktree id:<workspace> --json`: when an entry of `result.tabs` has a `url` starting with <origin>, `orca goto --worktree id:<workspace> --page <its browserPageId> --url <url> --json`, then `orca tab switch --worktree id:<workspace> --page <its browserPageId> --focus --json`; when none does, `orca tab create --worktree id:<workspace> --url <url> --json`, and for `right`, `left`, `down`, or `up` with `--split {browser|tab}` added, so it opens beside the agent's pane. A tab it reuses stays where it is. The tab's id is its `browserPageId`",
      },
    },
    workspaces: {
      workspaces: {
        cli: "`orca worktree list --json --repo {repo} --limit 1000` (with <repository>, `id:<that repo's id>`, as for `createWorkspace`), keeping the entries of `result.worktrees` whose `isArchived` is false. Each one's id is its `id` (the whole `<repo id>::<path>` value), its name its `displayName`, its branch its `branch` without `refs/heads/`, and it has no section. This session runs in the one whose `id` is `$ORCA_WORKTREE_ID`, or, with that unset, whose `path` is `git rev-parse --show-toplevel`",
      },
      renameWorkspace: {
        cli: "`orca worktree set --json --worktree id:<id> --display-name <name>`. Orca has no sidebar sections, so a <section> doesn't apply: say so when one is given",
      },
      createWorkspace: {
        cli: "With <repository>, in place of `{repo}` `id:<its id>` for the entry of `orca repo list --json` whose `displayName` or `id` is <repository> (none: say so, listing the names, and open nothing), and for <base> that repo's default branch, from `git -C <its path> symbolic-ref --short refs/remotes/origin/HEAD` without the `origin/`. Orca has no sidebar sections, so a <section> doesn't apply: say so when one is given. When <exact> is `no`, first put <branch> under the prefix most of the person's own branches carry (`sam/` in `git for-each-ref --format='%(refname:short)' refs/heads`), when they carry one. Then `git fetch origin`. When <branch> doesn't exist yet (locally or on origin): `orca worktree create --json --repo {repo} --no-parent --name <name> --branch <branch> --base-branch origin/<base> --agent {agent|claude} --prompt \"$(cat <prompt-file>)\"`; its JSON `result.worktree` holds the new worktree's `id`, `path`, and `branch` (without `refs/heads/`) (Orca adds `-2`, `-3`, … when the name is taken, so report the branch it gives). When <branch> exists, Orca's CLI can't open it (it makes `<branch>-2` instead), so check it out yourself: `git worktree add <path> <branch>` from the main checkout, with <path> next to this repo's other Orca worktrees (in the folder holding the `path` of the entries of `orca worktree list --json --repo {repo}` whose `isMainWorktree` is false; with none, the repo's `worktreeBasePath` in `orca repo list --json` when it has one, else `~/orca/workspaces/<repo name>/`, Orca's default) named after the branch with each `/` turned into `-`; then `orca worktree set --json --worktree path:<path> --display-name <name>` and `orca agent launch --json --worktree path:<path> --agent {agent|claude} --prompt \"$(cat <prompt-file>)\"`. When Orca doesn't list that path (`selector_not_found`: a repo can hide worktrees Orca didn't make), print `cd <path> && {agent|claude} \"$(cat <prompt-file>)\"` for the person to run. Prints the workspace's id (or path), its branch, and its path",
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

import os from "node:os"
import path from "node:path"
import type {
  IntegrationSpec,
  MachineValues,
  SectionValues,
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

/** Where Conductor checks out its local workspaces. */
export const CONDUCTOR_WORKSPACES = "/conductor/workspaces/"

/** Where Conductor's app keeps its CLI, which may not be on PATH. */
const APP_CLI = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "com.conductor.app",
  "bin",
  "conductor",
)

type Project = Record<string, unknown>

/** Every string in a project, a level or two down, for finding its repo. */
function strings(value: unknown, depth = 2): string[] {
  if (typeof value === "string") {
    return [value]
  }
  if (depth < 0 || typeof value !== "object" || value === null) {
    return []
  }
  return Object.values(value).flatMap((v) => strings(v, depth - 1))
}

const idOf = (p: Project): string | undefined => {
  const id = p.id ?? p.projectId
  return typeof id === "string" && SLUG.regex.test(id) ? id : undefined
}

/**
 * This repository's project in `conductor project list --json` output, or
 * why there's none: the configured `projectId` when this account can see it
 * (a Conductor project is its organization's, so the team can share one),
 * else the one whose repository is origin, by URL or `owner/repo`.
 */
export function conductorProjectIn(
  stdout: string,
  checkout: Checkout,
  configured?: string,
): MachineValues {
  let projects: Project[]
  try {
    const parsed: unknown = JSON.parse(stdout)
    const box = parsed as Record<string, unknown> | null
    const result = box?.result as Record<string, unknown> | undefined
    const list = Array.isArray(parsed)
      ? parsed
      : (box?.projects ?? box?.data ?? result?.projects)
    projects = (Array.isArray(list) ? list : []).filter(
      (p): p is Project => typeof p === "object" && p !== null && !!idOf(p),
    )
  } catch {
    return {
      problem:
        "`conductor project list --json` printed something other than JSON.",
    }
  }
  if (configured && projects.some((p) => idOf(p) === configured)) {
    return { values: { projectId: configured } }
  }
  const host = remoteKey(checkout.origin)?.split("/")[0]
  const found = pickEntry(projects, checkout, {
    pathOf: (p) => (typeof p.path === "string" ? p.path : undefined),
    keysOf: (p) =>
      strings(p).flatMap((text) => [
        remoteKey(text),
        // `owner/repo`, as a project may name its GitHub repository.
        host && /^[\w.-]+\/[\w.-]+$/.test(text)
          ? `${host}/${text}`.toLowerCase()
          : undefined,
      ]),
  })
  if ("entry" in found) {
    return { values: { projectId: idOf(found.entry) as string } }
  }
  const stale = configured
    ? ` The config's \`projectId\` (${configured}) isn't one this Conductor account can see: it may belong to another organization.`
    : ""
  if ("ambiguous" in found) {
    const listed = found.ambiguous
      .map((p) => `${String(p.name ?? idOf(p))} (${idOf(p)})`)
      .join(", ")
    return {
      problem: `Conductor has several projects for this repository: ${listed}.${stale} Set \`projectId\` to the team's in the config.`,
    }
  }
  return {
    problem: `Conductor has no project for this repository (${where(checkout)}) that this account can see.${stale} Add it in Conductor's app, or join the organization that has it, then run this again.`,
  }
}

/** This repository's Conductor project, for this account. */
export async function conductorProject(
  session: SessionContext,
  values: SectionValues,
): Promise<MachineValues> {
  const checkout = await checkoutOf(session)
  const configured =
    typeof values.projectId === "string" ? values.projectId : undefined
  for (const bin of ["conductor", APP_CLI]) {
    const out = await session.run(
      [bin, "project", "list", "--json"],
      session.root,
    )
    if (out !== undefined) {
      return conductorProjectIn(out, checkout, configured)
    }
  }
  return {
    problem:
      "Couldn't list Conductor's projects (`conductor project list --json` failed). Install Conductor's CLI and sign in: check `conductor auth whoami`.",
  }
}

// Conductor's CLI drives cloud workspaces only: local ones open from its app,
// with no CLI or API for them.
export const conductor: IntegrationSpec = {
  path: "integrations.conductor",
  name: "Conductor",
  purpose: "Cloud workspaces, each a sandbox with a coding agent working in it",
  fields: [
    {
      key: "projectId",
      description:
        "Conductor project id for this repository, when the team shares one Conductor organization. Optional: flows use it when this account can see it, and otherwise find the project whose repository is origin",
      example: "proj_4f9a2c",
      pattern: SLUG,
    },
    {
      key: "agent",
      description:
        "Agent new workspaces start (claude, codex, cursor): the team's default, only when the team agreed on one. Each person's own choice goes in this machine's override (`configure local`)",
      example: "claude",
      pattern: SLUG,
    },
  ],
  lookup:
    "Optional: `conductor project list --json`, the project whose repository is this one's origin, recorded only when the team shares one Conductor organization (flows find it on each machine otherwise). Outside a Conductor workspace the CLI may not be on PATH: the app keeps it at `~/Library/Application Support/com.conductor.app/bin/conductor`",
  access: {
    cli: { bin: "conductor", auth: ["conductor", "auth", "whoami"] },
  },
  // A Conductor project belongs to an organization, so the id is shared only
  // inside one: flows check it against this account's projects, and find the
  // repository's own when it isn't there.
  machine: { keys: ["projectId"], resolve: conductorProject },
  // Env only: its CLI drives cloud workspaces, so it can't place a local one.
  // Both are set in local and cloud workspaces alike (its environment
  // variables reference); there's no workspace id variable.
  session: { env: ["CONDUCTOR_WORKSPACE_NAME", "CONDUCTOR_WORKSPACE_PATH"] },
  provides: {
    workspaces: {
      workspaces: {
        cli: "`conductor project workspace {projectId} --json --limit 100` (with <repository>, that project's id, as for `createWorkspace`), stepping `--offset` while the response reports `hasMore`: each workspace's id, name, branch, and section. This session runs in the one whose name is `$CONDUCTOR_WORKSPACE_NAME` (a local workspace isn't listed: the CLI sees cloud ones only)",
      },
      renameWorkspace: {
        cli: "`conductor workspace rename <id> --name <name>`. For a <section>, find or make it as for `createWorkspace`, then `conductor workspace move <id> --section <section id>`; for `none`, `conductor workspace move <id> --no-section`",
      },
      createWorkspace: {
        cli: "With <repository>, in place of `{projectId}` the id of the project `conductor project list --json` names <repository> (none: say so, listing the names, and open nothing). `conductor workspace create --json --project-id {projectId} --name <name> --session-name <name> --agent {agent|claude} --message-file <prompt-file>`, which opens a cloud workspace: Conductor's CLI can't open local ones, which open only from its app. Conductor names the new branch itself, so <branch> is only a suggestion, except that with <exact> `yes` add `--branch <branch>` to start from that branch. For a <section>, find its id by name in `conductor section list --json`, else make it with `conductor section create <section> --json`, then `conductor workspace move <workspace id> --section <section id>`. It prints the workspace's id, its branch, and a deep link to open it",
      },
    },
  },
  detect(ctx) {
    const evidence = [".conductor/settings.toml", "conductor.json"]
      .filter((file) => ctx.tracked.includes(file))
      .map((file) => `${file} is tracked`)
    const worktrees = ctx.git(["worktree", "list", "--porcelain"]) ?? ""
    if (ctx.env.CONDUCTOR_WORKSPACE_NAME) {
      evidence.push("this session runs in Conductor")
    }
    if (worktrees.includes(CONDUCTOR_WORKSPACES)) {
      evidence.push("git worktrees checked out by Conductor")
    }
    return evidence.length > 0 ? { values: {}, evidence } : undefined
  },
}

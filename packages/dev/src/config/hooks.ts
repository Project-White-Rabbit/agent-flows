// Hooks: a repo's own steps at named points in the flows, for work no
// integration covers (see `Hook`). Integrations are the same for every repo on
// a vendor; hooks are what's this repo's own.
//
// Two levels. General points (`hooks.before`, `hooks.after`) run around every
// command but configure; a flow's own points run at its steps. Modes and
// outcomes are filters on a hook, not more points, so the list of points stays
// short. Each point's rules (when it runs, side effects, what a failure does)
// live here, and its config field is built from them.
//
// Runtime code: Node built-ins only.

import { INSTANCE_NAME } from "./instances.ts"
import { type FieldSpec, HOOK_KEYS, type Hook } from "./types.ts"

/** Values a hook's commands and prompt can use, as `{name}` and in the environment. */
export const HOOK_VARS = ["base", "branch", "outcome", "pr", "prs"] as const

export type HookVar = (typeof HOOK_VARS)[number]

export const HOOK_OUTCOMES = ["success", "failure"] as const

export type HookOutcome = (typeof HOOK_OUTCOMES)[number]

export type HookPoint = {
  /** Its config path: `hooks.before`, `ready.beforePublish`. */
  id: string
  /** The flow whose step runs it; none for a general point. */
  flow?: string
  /** When it runs, for the docs and the config field. */
  when: string
  /** What its commands may touch, for the docs and the config field. */
  effects: string
  /**
   * `stop`: a failure stops the command. `report`: the rest still run, and
   * the command reports the failure; for points after the work is done.
   */
  failure: "stop" | "report"
  /** An `after` point: it knows the outcome, so hooks there can filter on it. */
  after?: boolean
  example: Hook[]
}

const NO_SHARED_EFFECTS =
  "Commands may change the checkout, but not deploy, publish, migrate, or write to a shared service or database"

export const HOOK_POINTS: HookPoint[] = [
  {
    id: "hooks.before",
    when: "At the start of every dev-flows command but configure, before its first step, once its mode is known",
    effects: `${NO_SHARED_EFFECTS}, since it runs before ready too`,
    failure: "stop",
    example: [{ name: "env", run: "./scripts/sync-worktree-env.sh" }],
  },
  {
    id: "hooks.after",
    when: "At the end of every dev-flows command but configure, finished or stopped, just before its report, after the command's own `after` hooks",
    effects:
      "Commands may have side effects outside the checkout (a notification)",
    failure: "report",
    after: true,
    example: [
      {
        name: "notify",
        on: "failure",
        run: "./scripts/notify.sh {outcome}",
      },
    ],
  },
  {
    id: "ready.before",
    flow: "ready",
    when: "Once ready has scoped the branch, before its local cleanup: for what CI enforces that no integration covers (a version bump, a release collision, a migration check), and rules for when certain paths change",
    effects: NO_SHARED_EFFECTS,
    failure: "stop",
    example: [
      {
        name: "version-bump",
        run: "./scripts/check-version.sh {base}",
        fix: "bun run bump patch",
      },
      {
        name: "sdk-docs",
        paths: ["sdks/**"],
        prompt: "Update the SDK docs for what this branch changed",
      },
    ],
  },
  {
    id: "ready.beforePublish",
    flow: "ready",
    when: "After ready's local cleanup and checks, before it commits and pushes: what the files to publish need last (regenerated screenshots). What hooks change is committed with the rest",
    effects: NO_SHARED_EFFECTS,
    failure: "stop",
    example: [
      {
        name: "screenshots",
        paths: ["ui/**"],
        run: "bun run screenshots",
      },
    ],
  },
  {
    id: "ready.after",
    flow: "ready",
    when: "At the end of ready, finished or stopped, just before its report",
    effects:
      "Commands may have side effects outside the checkout; ready's work is published by then",
    failure: "report",
    after: true,
    example: [
      {
        name: "announce",
        modes: ["default", "loop"],
        on: "success",
        prompt: "Post the pull request in #reviews",
      },
    ],
  },
  {
    id: "merge.before",
    flow: "merge",
    when: "After merge's pre-flight gates pass, before it syncs, waits for CI, or merges anything",
    effects: NO_SHARED_EFFECTS,
    failure: "stop",
    example: [{ name: "changelog", run: "./scripts/check-changelog.sh" }],
  },
  {
    id: "merge.beforeCi",
    flow: "merge",
    when: "After merge has synced the branch and marked its pull request ready, before it waits for CI on the commit that lands: for a commit that must land with the merge (a changelog entry), which the hook makes and pushes, so CI runs on it",
    effects:
      "Commands may change and push the branch, but not deploy, publish, migrate, or write to any other shared service",
    failure: "stop",
    example: [
      {
        name: "changelog",
        prompt:
          "Add this pull request's changelog entry, commit it, and push it",
      },
    ],
  },
  {
    id: "merge.after",
    flow: "merge",
    when: "At the end of merge, merged or stopped, just before its report: teardown the repo does itself (a preview server, a database it manages)",
    effects:
      "Commands may have side effects outside the checkout: that's what teardown is",
    failure: "report",
    after: true,
    example: [
      {
        name: "server-down",
        on: "success",
        run: "./scripts/dev-server.sh down {branch}",
      },
    ],
  },
  {
    id: "close.before",
    flow: "close",
    when: "After close's survey and gates, before it closes the pull request or deletes anything: a check that must pass before the branch's work is thrown away",
    effects: NO_SHARED_EFFECTS,
    failure: "stop",
    example: [
      { name: "unpushed-data", run: "./scripts/check-exports.sh {branch}" },
    ],
  },
  {
    id: "close.after",
    flow: "close",
    when: "At the end of close, finished or stopped, just before its report: teardown of what the repo set up for the branch itself (a database branch, dev servers, a marker that it's closed)",
    effects:
      "Commands may have side effects outside the checkout: that's what teardown is",
    failure: "report",
    after: true,
    example: [
      {
        name: "db-branch",
        on: "success",
        run: "./scripts/db-branch.sh delete {branch}",
      },
    ],
  },
]

/** The flows the general points run around: every flow but configure. */
export const HOOK_FLOWS = [
  "close",
  "create-tickets",
  "evaluate",
  "merge",
  "ready",
  "start-work",
  "sync",
  "tickets-to-work",
] as const

/** The modes a flow's own hooks can filter on, for the flows that have points. */
export const FLOW_MODES: Record<string, string[]> = {
  ready: ["default", "loop", "draft"],
  merge: ["default"],
  close: ["default", "force"],
}

export function hookPoint(id: string): HookPoint | undefined {
  return HOOK_POINTS.find((point) => point.id === id)
}

/** The points a command passes to `hooks.ts run`: `before`, `ready.after`. */
export function pointName(point: HookPoint): string {
  return point.id.startsWith("hooks.")
    ? point.id.slice("hooks.".length)
    : point.id
}

/** A section's field for one of its points. */
export function hookField(id: string): FieldSpec {
  const point = hookPoint(id)
  if (!point) {
    throw new Error(`no hook point ${id}`)
  }
  const failure =
    point.failure === "stop"
      ? "A failure stops the command."
      : "A failure is reported, and the rest still run."
  return {
    key: id.split(".").at(-1) as string,
    type: "hook[]",
    description: `${point.when}. ${point.effects}. ${failure}`,
    example: point.example,
  }
}

const UNKNOWN_NOTE = "kept as is; it may come from a newer plugin"

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmpty)
}

/**
 * Problems in the hook list at `where` (a point's config path), and keys a
 * newer plugin may know.
 */
export function checkHooks(
  value: unknown,
  where: string,
  warnings: string[],
): string[] {
  if (!Array.isArray(value)) {
    return [`${where} must be a list of hooks`]
  }
  const point = hookPoint(where)
  const modes = point?.flow ? FLOW_MODES[point.flow] : undefined
  const issues: string[] = []
  const names = new Set<string>()
  for (const [index, hook] of value.entries()) {
    if (typeof hook !== "object" || hook === null || Array.isArray(hook)) {
      issues.push(`${where}[${index}] must be an object`)
      continue
    }
    const entry = hook as Record<string, unknown>
    const named =
      typeof entry.name === "string" && INSTANCE_NAME.test(entry.name)
    const at = named ? `${where}[${entry.name}]` : `${where}[${index}]`
    if (!named) {
      issues.push(
        `${at}.name must be lowercase letters, digits, ".", "_", or "-"`,
      )
    } else if (names.has(entry.name as string)) {
      issues.push(`${where} has two hooks named "${entry.name}"`)
    } else {
      names.add(entry.name as string)
    }
    for (const key of Object.keys(entry)) {
      if (!(HOOK_KEYS as readonly string[]).includes(key)) {
        warnings.push(`unknown field "${at}.${key}" (${UNKNOWN_NOTE})`)
      }
    }
    for (const key of ["run", "fix", "prompt"] as const) {
      if (entry[key] !== undefined && !nonEmpty(entry[key])) {
        issues.push(`${at}.${key} must be a non-empty string`)
      }
    }
    if ((entry.run === undefined) === (entry.prompt === undefined)) {
      issues.push(`${at} must have either run or prompt`)
    }
    if (entry.fix !== undefined && entry.run === undefined) {
      issues.push(`${at}.fix needs a run command to check it`)
    }
    if (entry.timeout !== undefined) {
      if (entry.run === undefined) {
        issues.push(`${at}.timeout is only for a run command`)
      } else if (
        typeof entry.timeout !== "number" ||
        !Number.isInteger(entry.timeout) ||
        entry.timeout <= 0
      ) {
        issues.push(`${at}.timeout must be a whole number of seconds`)
      }
    }
    if (entry.paths !== undefined && !stringList(entry.paths)) {
      issues.push(`${at}.paths must be a list of non-empty globs`)
    }
    if (entry.modes !== undefined) {
      if (!modes) {
        issues.push(
          `${at}.modes is only for a flow's own points: put the hook in that flow's section`,
        )
      } else if (
        !stringList(entry.modes) ||
        !entry.modes.every((mode) => modes.includes(mode))
      ) {
        issues.push(
          `${at}.modes must list modes of ${point?.flow}: ${modes.join(", ")}`,
        )
      }
    }
    if (entry.on !== undefined) {
      if (point && !point.after) {
        issues.push(
          `${at}.on is only for an after point, which knows the outcome`,
        )
      } else if (!(HOOK_OUTCOMES as readonly unknown[]).includes(entry.on)) {
        issues.push(`${at}.on must be ${HOOK_OUTCOMES.join(" or ")}`)
      }
    }
  }
  return issues
}

/** A repo-relative glob as a regex: `*` within a directory, `**` across them. */
export function globRegex(glob: string): RegExp {
  let out = ""
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches no directories too, so `a/**/b` matches `a/b`.
        const slash = glob[i + 2] === "/"
        out += slash ? "(?:.*/)?" : ".*"
        i += slash ? 2 : 1
      } else {
        out += "[^/]*"
      }
    } else if (char === "?") {
      out += "[^/]"
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${out}$`)
}

export type HookContext = {
  mode?: string
  outcome?: HookOutcome
  /** The branch's changed files, for `paths`; read only when a hook has them. */
  changed: () => string[]
}

/** Why a hook doesn't apply here, or undefined when it does. */
export function skipReason(
  hook: Hook,
  context: HookContext,
): string | undefined {
  if (hook.modes && !(context.mode && hook.modes.includes(context.mode))) {
    return `only in ${hook.modes.join(", ")} mode`
  }
  if (hook.on && hook.on !== context.outcome) {
    return `only on ${hook.on}`
  }
  if (hook.paths) {
    const patterns = hook.paths.map(globRegex)
    if (!context.changed().some((file) => patterns.some((p) => p.test(file)))) {
      return `no changed file matches ${hook.paths.join(", ")}`
    }
  }
  return undefined
}

/**
 * `{base}`, `{branch}`, `{outcome}`, `{pr}`, and `{prs}` filled in; unknown or
 * unset ones stay.
 */
export function fillVars(
  text: string,
  vars: Partial<Record<HookVar, string>>,
): string {
  return text.replace(
    /\{(base|branch|outcome|prs|pr)\}/g,
    (match, name: HookVar) => vars[name] ?? match,
  )
}

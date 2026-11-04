// Hooks: a repo's own steps at named points in the flows, for work no
// integration covers (see `Hook`). Integrations are the same for every repo on
// a vendor; hooks are what's this repo's own.
//
// Two levels. General points (`hooks.before`, `hooks.after`) run around every
// command but configure; a flow's own points run at its steps. Modes and
// outcomes are filters on a hook, not more points, so the list of points stays
// short; a general point's hook can filter on the flows it runs around too.
// Each point's rules (when it runs, side effects, what a failure does) live
// here, and its config field is built from them.
//
// Runtime code: Node built-ins only.

import { INSTANCE_NAME } from "./instances.ts"
import { type FieldSpec, HOOK_KEYS, type Hook } from "./types.ts"

/**
 * Values a hook's commands and prompt can use, as `{name}` and in the
 * environment (`AGENT_FLOWS_<NAME>`; `{merge}` is `AGENT_FLOWS_MERGE_COMMIT`).
 * A flow passes the ones it knows; the rest are empty.
 */
export const HOOK_VARS = [
  "base",
  "branch",
  "outcome",
  "pr",
  "prs",
  "issue",
  "result",
  "merge",
  "since",
  "scope",
] as const

export type HookVar = (typeof HOOK_VARS)[number]

export const HOOK_OUTCOMES = ["success", "failure"] as const

export type HookOutcome = (typeof HOOK_OUTCOMES)[number]

/**
 * What `on` can be: an outcome, or `merged` at a point that knows whether the
 * pull request merged, whatever happened after it.
 */
export const HOOK_ON = [...HOOK_OUTCOMES, "merged"] as const

/** What a flow says it did, for `{result}`, for the flows that say. */
export const FLOW_RESULTS: Record<string, string[]> = {
  // Which of sync's phases ran: neither, only the local git work, only the
  // remote writes, or both.
  sync: ["noop", "local", "remote", "full"],
}

/** How much of the branch `evaluate.scan` runs for, for `{scope}`. */
export const EVALUATE_SCOPES = ["full", "delta", "carry"] as const

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
  /**
   * It knows whether the pull request merged (`--merged`), so hooks there can
   * take `on: merged`.
   */
  merged?: boolean
  /**
   * What a command prints is findings for the flow to weigh: a command that
   * passes hands its stdout to the agent with the report, not only its exit.
   */
  findings?: boolean
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
    merged: true,
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
    id: "ready.beforePush",
    flow: "ready",
    when: "After ready's local sync has committed the branch, before it pushes: for a check that reads committed history (a scan of the commits about to publish). Ready commits what hooks change, with the repo's convention for the message, before it pushes",
    effects: NO_SHARED_EFFECTS,
    failure: "stop",
    example: [
      {
        name: "commit-scan",
        run: "./scripts/scan-commits.sh {base}",
      },
    ],
  },
  {
    id: "ready.beforeFixPush",
    flow: "ready",
    when: "In ready's CI step, after each batch of CI fixes is committed, before it's pushed: the checks `beforePush` runs, for the fix pushes it doesn't see. Ready commits what hooks change, with the repo's convention for the message, before it pushes",
    effects: NO_SHARED_EFFECTS,
    failure: "stop",
    example: [
      {
        name: "commit-scan",
        run: "./scripts/scan-commits.sh {base}",
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
    id: "evaluate.scan",
    flow: "evaluate",
    when: "Once evaluate has its scope, before it judges the change: the repo's own deterministic checks (a scan of the diff against its rules). What a passing command prints goes to the reviewer as findings to verify, each confirmed or set aside against the diff, never as the verdict",
    effects:
      "Commands only read: evaluate changes nothing, so they must not change the checkout or write anywhere",
    failure: "stop",
    findings: true,
    example: [
      {
        name: "rules-scan",
        run: "python3 scripts/review_scan.py --base {base}",
        timeout: 300,
        findings: "^(FINDING|UNTESTED):",
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
    when: "At the end of merge, merged or stopped, just before its report: teardown the repo does itself (a preview server, a database it manages). `on: merged` runs a hook whenever the pull request merged, even when what came after it (the deploy watch) failed",
    effects:
      "Commands may have side effects outside the checkout: that's what teardown is",
    failure: "report",
    after: true,
    merged: true,
    example: [
      {
        name: "server-down",
        on: "merged",
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

/**
 * The modes each flow's hooks can filter on: at its own points, and at a
 * general point with `flows`.
 */
export const FLOW_MODES: Record<string, string[]> = {
  close: ["default", "force"],
  "create-tickets": ["default", "match"],
  evaluate: ["default"],
  merge: ["default"],
  ready: ["default", "loop", "draft"],
  "start-work": ["default"],
  sync: ["default", "local", "remote"],
  "tickets-to-work": ["default"],
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
    // At a general point, `flows` says whose modes `modes` names.
    let flows: string[] | undefined
    if (entry.flows !== undefined) {
      if (point?.flow) {
        issues.push(
          `${at}.flows is only for a general point: this one runs only in ${point.flow}`,
        )
      } else if (
        !stringList(entry.flows) ||
        !entry.flows.every((flow) =>
          (HOOK_FLOWS as readonly string[]).includes(flow),
        )
      ) {
        issues.push(`${at}.flows must list flows of ${HOOK_FLOWS.join(", ")}`)
      } else {
        flows = entry.flows
      }
    }
    if (entry.modes !== undefined) {
      const modes = point?.flow
        ? FLOW_MODES[point.flow]
        : flows && [...new Set(flows.flatMap((flow) => FLOW_MODES[flow]))]
      const whose = point?.flow ?? flows?.join(", ")
      if (!modes) {
        if (entry.flows === undefined) {
          issues.push(
            `${at}.modes at a general point needs flows, to say whose modes they are`,
          )
        }
      } else if (
        !stringList(entry.modes) ||
        !entry.modes.every((mode) => modes.includes(mode))
      ) {
        issues.push(
          `${at}.modes must list modes of ${whose}: ${modes.join(", ")}`,
        )
      }
    }
    if (entry.on !== undefined) {
      if (point && !point.after) {
        issues.push(
          `${at}.on is only for an after point, which knows the outcome`,
        )
      } else if (!(HOOK_ON as readonly unknown[]).includes(entry.on)) {
        issues.push(`${at}.on must be ${HOOK_ON.join(", ")}`)
      } else if (entry.on === "merged" && point && !point.merged) {
        issues.push(
          `${at}.on: merged is only for merge.after and hooks.after, which know whether the pull request merged`,
        )
      }
    }
    if (entry.recheck !== undefined) {
      if (entry.run === undefined) {
        issues.push(`${at}.recheck is only for a run command`)
      } else if (typeof entry.recheck !== "boolean") {
        issues.push(`${at}.recheck must be true or false`)
      } else if (point?.findings) {
        issues.push(
          `${at}.recheck isn't for ${where}: its commands only read, so an exit 2 there stops rather than hands over a task`,
        )
      }
    }
    if (entry.findings !== undefined) {
      if (point && !point.findings) {
        issues.push(
          `${at}.findings is only for a point whose output is findings (evaluate.scan)`,
        )
      } else if (entry.run === undefined) {
        issues.push(`${at}.findings is only for a run command`)
      } else if (!nonEmpty(entry.findings) || !validRegex(entry.findings)) {
        issues.push(`${at}.findings must be a regular expression`)
      }
    }
  }
  return issues
}

function validRegex(source: string): boolean {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
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
  flow?: string
  mode?: string
  outcome?: HookOutcome
  /** The pull request merged, for `on: merged`. */
  merged?: boolean
  /** The branch's changed files, for `paths`; read only when a hook has them. */
  changed: () => string[]
}

/** Why a hook doesn't apply here, or undefined when it does. */
export function skipReason(
  hook: Hook,
  context: HookContext,
): string | undefined {
  if (hook.flows && !(context.flow && hook.flows.includes(context.flow))) {
    return `only around ${hook.flows.join(", ")}`
  }
  if (hook.modes && !(context.mode && hook.modes.includes(context.mode))) {
    return `only in ${hook.modes.join(", ")} mode`
  }
  if (hook.on === "merged") {
    if (!context.merged) {
      return "only when the pull request merged"
    }
  } else if (hook.on && hook.on !== context.outcome) {
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

const VAR_PATTERN = new RegExp(`\\{(${HOOK_VARS.join("|")})\\}`, "g")

/** Each of `HOOK_VARS` (`{base}`, `{pr}`) filled in; unknown or unset ones stay. */
export function fillVars(
  text: string,
  vars: Partial<Record<HookVar, string>>,
): string {
  return text.replace(
    VAR_PATTERN,
    (match, name: HookVar) => vars[name] ?? match,
  )
}

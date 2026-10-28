// The repo's hooks at a flow's points (see config/hooks.ts): which apply,
// running each command with its fix and timeout, and handing prompts and
// exit-2 output to the agent. One call runs its points' lists in order and
// stops at the first task for the agent, so that work lands between the hooks
// around it; `--after` picks the lists back up where it stopped.
//
// Logs go in the worktree's own git dir, one file per hook, overwritten by its
// next run.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { getAt } from "../config/config.ts"
import {
  checkHooks,
  fillVars,
  HOOK_FLOWS,
  HOOK_OUTCOMES,
  type HookContext,
  type HookOutcome,
  type HookPoint,
  type HookVar,
  hookPoint,
  pointName,
  skipReason,
} from "../config/hooks.ts"
import type { Hook } from "../config/types.ts"
import { loadConfig } from "./configure.ts"
import {
  isMain,
  parseFlags,
  printJson,
  requiredFlag,
  run,
  runMain,
  runSubcommand,
  UsageError,
} from "./lib.ts"

/** Seconds a hook's command may run when it doesn't set `timeout`. */
export const DEFAULT_TIMEOUT = 60

/** Lines of a failed command's output printed; the rest stay in its log. */
const OUTPUT_LINES = 40

export type HookRun = {
  point: string
  name: string
  result: "passed" | "fixed" | "failed" | "timedOut" | "skipped"
  /** Why it was skipped. */
  reason?: string
  seconds?: number
  log?: string
  /** The end of a failed command's output. */
  output?: string
}

export type HookReport = {
  /**
   * `done`: every hook ran or was skipped. `agent`: a hook handed the agent a
   * task; run again with `--after <resume>` once it's done. `stop`: a hook
   * failed at a point where that stops the command.
   */
  status: "done" | "agent" | "stop"
  ran: HookRun[]
  /** Failures at points that report them rather than stop. */
  failures: HookRun[]
  agent?: { point: string; name: string; task: string; resume: string }
  stop?: HookRun
}

export type HookRequest = {
  points: HookPoint[]
  flow: string
  mode?: string
  /** The branch's merge base; else from `repo.baseBranch`. */
  base?: string
  /** The branch; else the current one. */
  branch?: string
  outcome?: HookOutcome
  /** The pull request's number, when the flow has one. */
  pr?: string
  /** Every pull request the command lands, bottom first, space-separated. */
  prs?: string
  /** The `<point>/<name>` a previous call stopped at. */
  after?: string
  /** Don't run fixes: for trying a hook, which mustn't change the checkout. */
  noFix?: boolean
}

type Exec = {
  code: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  seconds: number
}

function git(root: string, args: string[]): string | undefined {
  const result = run("git", ["-C", root, ...args])
  return result.status === 0 ? result.stdout.trim() : undefined
}

function lines(text: string | undefined): string[] {
  return (text ?? "").split("\n").filter(Boolean)
}

/**
 * The branch's merge base with the repo's base branch (its remote copy when
 * there is one), for `{base}` and `paths` when the flow didn't pass one.
 */
function defaultBase(
  root: string,
  config: Record<string, unknown>,
): string | undefined {
  const base = getAt(config, "repo.baseBranch")
  if (typeof base !== "string") {
    return undefined
  }
  for (const ref of [`origin/${base}`, base]) {
    const mergeBase = git(root, ["merge-base", ref, "HEAD"])
    if (mergeBase) {
      return mergeBase
    }
  }
  return undefined
}

/** What the pull request will hold: committed since `base`, uncommitted, and untracked. */
function changedFiles(root: string, base: string | undefined): string[] {
  return [
    ...new Set([
      ...(base ? lines(git(root, ["diff", "--name-only", base, "HEAD"])) : []),
      ...lines(git(root, ["diff", "--name-only", "HEAD"])),
      ...lines(git(root, ["ls-files", "--others", "--exclude-standard"])),
    ]),
  ].sort()
}

function exec(
  command: string,
  root: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Exec {
  const started = Date.now()
  const result = spawnSync("sh", ["-c", command], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: timeout * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  })
  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
  return {
    code: result.error ? null : result.status,
    timedOut,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    seconds: Math.round((Date.now() - started) / 100) / 10,
  }
}

function tail(text: string): string {
  return text.trimEnd().split("\n").slice(-OUTPUT_LINES).join("\n")
}

/** Run the hooks at `request.points`, in order, as the report says. */
export function runHooks(
  root: string,
  config: Record<string, unknown>,
  request: HookRequest,
): HookReport {
  const logDir = path.join(
    git(root, ["rev-parse", "--absolute-git-dir"]) ?? path.join(root, ".git"),
    "agent-flows",
    "hooks",
    "logs",
  )
  let resolved:
    | { base?: string; changed: string[]; changedFile: string }
    | undefined
  // Read git only when a hook needs it, so a point with no hooks costs nothing.
  const context = () => {
    if (!resolved) {
      const base = request.base ?? defaultBase(root, config)
      const changed = changedFiles(root, base)
      fs.mkdirSync(logDir, { recursive: true })
      const changedFile = path.join(logDir, "changed.txt")
      fs.writeFileSync(changedFile, changed.map((f) => `${f}\n`).join(""))
      resolved = { base, changed, changedFile }
    }
    return resolved
  }
  const branch = () =>
    request.branch ?? git(root, ["branch", "--show-current"]) ?? ""
  const filters: HookContext = {
    mode: request.mode,
    outcome: request.outcome,
    changed: () => context().changed,
  }

  const report: HookReport = { status: "done", ran: [], failures: [] }
  let resuming = request.after !== undefined
  for (const point of request.points) {
    const list = getAt(config, point.id)
    for (const hook of Array.isArray(list) ? (list as Hook[]) : []) {
      const marker = `${pointName(point)}/${hook.name}`
      if (resuming) {
        resuming = marker !== request.after
        continue
      }
      const at = { point: pointName(point), name: hook.name }
      const reason = skipReason(hook, filters)
      if (reason) {
        report.ran.push({ ...at, result: "skipped", reason })
        continue
      }
      const { base, changedFile } = context()
      const vars: Partial<Record<HookVar, string>> = {
        base,
        branch: branch(),
        outcome: request.outcome,
        pr: request.pr,
        prs: request.prs,
      }
      if (hook.prompt !== undefined) {
        report.status = "agent"
        report.agent = {
          ...at,
          task: fillVars(hook.prompt, vars),
          resume: marker,
        }
        return report
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_FLOWS_FLOW: request.flow,
        AGENT_FLOWS_MODE: request.mode ?? "",
        AGENT_FLOWS_POINT: pointName(point),
        AGENT_FLOWS_HOOK: hook.name,
        AGENT_FLOWS_BASE: base ?? "",
        AGENT_FLOWS_BRANCH: vars.branch,
        AGENT_FLOWS_OUTCOME: request.outcome ?? "",
        AGENT_FLOWS_PR: request.pr ?? "",
        AGENT_FLOWS_PRS: request.prs ?? "",
        AGENT_FLOWS_CHANGED_FILES: changedFile,
      }
      const timeout = hook.timeout ?? DEFAULT_TIMEOUT
      const log = path.join(logDir, `${pointName(point)}-${hook.name}.log`)
      const runs: string[] = []
      const attempt = (command: string, label: string): Exec => {
        const result = exec(fillVars(command, vars), root, env, timeout)
        runs.push(
          `$ ${label}: ${command}\n${result.stdout}${result.stderr}${
            result.timedOut
              ? `\n[timed out after ${timeout}s]\n`
              : `\n[exit ${result.code}]\n`
          }`,
        )
        fs.writeFileSync(log, runs.join("\n"))
        return result
      }

      let result = attempt(hook.run as string, "run")
      let fixed = false
      if (
        result.code !== 0 &&
        result.code !== 2 &&
        !result.timedOut &&
        !request.noFix &&
        hook.fix
      ) {
        const repair = attempt(hook.fix, "fix")
        if (repair.code === 0) {
          result = attempt(hook.run as string, "run")
          fixed = true
        } else {
          result = repair
        }
      }
      const seconds = result.seconds
      if (result.code === 0) {
        report.ran.push({
          ...at,
          result: fixed ? "fixed" : "passed",
          seconds,
          log,
        })
        continue
      }
      if (result.code === 2 && !result.timedOut) {
        report.ran.push({ ...at, result: "passed", seconds, log })
        report.status = "agent"
        report.agent = {
          ...at,
          task:
            result.stderr.trim() ||
            result.stdout.trim() ||
            `The ${hook.name} hook exited 2 with no output; read its log: ${log}`,
          resume: marker,
        }
        return report
      }
      const failed: HookRun = {
        ...at,
        result: result.timedOut ? "timedOut" : "failed",
        seconds,
        log,
        output: tail(`${result.stdout}${result.stderr}`),
      }
      report.ran.push(failed)
      if (point.failure === "stop") {
        report.status = "stop"
        report.stop = failed
        return report
      }
      report.failures.push(failed)
    }
  }
  if (resuming) {
    throw new UsageError(
      `no hook ${request.after} at ${request.points.map(pointName).join(", ")}`,
    )
  }
  return report
}

/** `before`, `after`, `ready.before`: the points a flow asked for, checked against it. */
export function parsePoints(names: string[], flow: string): HookPoint[] {
  if (!(HOOK_FLOWS as readonly string[]).includes(flow)) {
    throw new UsageError(`--flow must be one of ${HOOK_FLOWS.join(", ")}`)
  }
  if (names.length === 0) {
    throw new UsageError(
      "name at least one point: before, after, or <flow>.<point>",
    )
  }
  return names.map((name) => {
    const point = hookPoint(name.includes(".") ? name : `hooks.${name}`)
    if (!point) {
      throw new UsageError(`no hook point \`${name}\``)
    }
    if (point.flow && point.flow !== flow) {
      throw new UsageError(
        `\`${name}\` is ${point.flow}'s point, not ${flow}'s`,
      )
    }
    return point
  })
}

type Args = { points: string[]; flags: Map<string, string> }

function request(
  args: Args,
  options: { allowInvalid?: boolean } = {},
): {
  root: string
  config: Record<string, unknown>
  request: HookRequest
} {
  const flow = requiredFlag(args.flags, "flow")
  const points = parsePoints(args.points, flow)
  const outcome = args.flags.get("outcome")
  if (
    outcome !== undefined &&
    !(HOOK_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    throw new UsageError(`--outcome must be ${HOOK_OUTCOMES.join(" or ")}`)
  }
  if (!outcome && points.some((point) => point.after)) {
    throw new UsageError("an after point needs --outcome success or failure")
  }
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"])
  if (!root) {
    throw new UsageError("not inside a git checkout")
  }
  const loaded = loadConfig(root)
  // Trying a hook reads only the base branch, so it works on a file that's
  // still being fixed.
  if (
    loaded.exists &&
    !loaded.config &&
    !(options.allowInvalid && loaded.draft)
  ) {
    throw new UsageError(
      `${loaded.configPath} has problems, so its hooks can't run: ${loaded.issues.join("; ")}. Run configure to fix it.`,
    )
  }
  return {
    root,
    config: loaded.config ?? loaded.draft ?? {},
    request: {
      points,
      flow,
      mode: args.flags.get("mode"),
      base: args.flags.get("base"),
      branch: args.flags.get("branch"),
      outcome: outcome as HookOutcome | undefined,
      pr: args.flags.get("pr"),
      prs: args.flags.get("prs"),
      after: args.flags.get("after"),
    },
  }
}

/**
 * Try one hook that isn't in the config yet, at a point that runs before the
 * work, so configure can check it before writing it. Its filters are ignored
 * (it runs whatever the branch changed) and its fix isn't run, since that
 * would change the checkout.
 */
export function tryHook(
  root: string,
  config: Record<string, unknown>,
  point: HookPoint,
  hook: Hook,
  rest: Omit<HookRequest, "points" | "noFix">,
): HookReport & { fix?: string } {
  if (point.after) {
    throw new UsageError(
      `${point.id} runs after the work and may have side effects, so it isn't tried: read the command instead`,
    )
  }
  const warnings: string[] = []
  const issues = checkHooks([hook], point.id, warnings)
  if (issues.length > 0) {
    throw new UsageError(`not a valid hook: ${issues.join("; ")}`)
  }
  const { paths: _paths, modes: _modes, on: _on, ...bare } = hook
  const [section, key] = [
    point.id.split(".").slice(0, -1).join("."),
    point.id.split(".").at(-1) as string,
  ]
  const trial = { repo: config.repo, [section]: { [key]: [bare] } }
  const report = runHooks(root, trial, {
    ...rest,
    points: [point],
    noFix: true,
  })
  return report.status === "stop" && hook.fix
    ? { ...report, fix: `not run: it would change the checkout (${hook.fix})` }
    : report
}

const USAGE = `Usage: hooks.ts run <point>... --flow <flow> [flags]
       hooks.ts try <point> --hook '<json>' [flags]

  run <point>...  Run the repo's hooks at these points, in order: \`before\`
      or \`after\` (around every command), or a flow's own (\`ready.before\`,
      \`merge.after\`). Prints JSON: \`status\` (done, agent, or stop), \`ran\`
      (each hook's result: passed, fixed, failed, timedOut, or skipped and
      why), \`failures\` (at points that report rather than stop), \`agent\`
      (a task for the agent: a prompt, or what a command printed when it
      exited 2; run again with --after <its resume> once it's done), and
      \`stop\` (the hook that failed).

  try <point>     Try one hook that isn't configured yet, given as JSON, at
      a point before the work (not an after point: those can have side
      effects). Ignores its paths, modes, and on, and doesn't run its fix.
      Prints the same JSON as run, plus \`fix\` when a fix wasn't run.

Flags:
  --hook <json>          The hook to try (try only)
  --flow <flow>          The command running them (${HOOK_FLOWS.join(", ")})
  --mode <mode>          Its mode, for hooks with \`modes\`
  --base <ref>           The branch's merge base; else from repo.baseBranch
  --branch <name>        The branch; else the current one
  --outcome <outcome>    success or failure; needed at an after point
  --pr <number>          The pull request's number, for {pr}
  --prs <numbers>        Every pull request it lands, bottom first, for {prs}
                         (space-separated; one for a single branch)
  --after <point>/<name> Go on after this hook, where a call stopped

Exit 0 whatever the hooks did; 2 for bad arguments or an invalid config.`

export function main(argv: string[]): void {
  runSubcommand<Args>(
    argv,
    USAGE,
    {
      run: (args) => {
        const { root, config, request: req } = request(args)
        printJson(runHooks(root, config, req))
      },
      try: (args) => {
        const [name, ...extra] = args.points
        if (!name || extra.length > 0) {
          throw new UsageError("try takes one point")
        }
        const point = hookPoint(name.includes(".") ? name : `hooks.${name}`)
        if (!point) {
          throw new UsageError(`no hook point \`${name}\``)
        }
        if (point.after) {
          throw new UsageError(
            `${point.id} runs after the work and may have side effects, so it isn't tried: read the command instead`,
          )
        }
        const text = requiredFlag(args.flags, "hook")
        let hook: Hook
        try {
          hook = JSON.parse(text) as Hook
        } catch {
          throw new UsageError("--hook must be a hook as JSON")
        }
        if (!args.flags.has("flow")) {
          args.flags.set("flow", point.flow ?? "ready")
        }
        const {
          root,
          config,
          request: req,
        } = request(
          { points: [name], flags: args.flags },
          { allowInvalid: true },
        )
        printJson(tryHook(root, config, point, hook, req))
      },
    },
    (rest) => {
      const first = rest.findIndex((arg) => arg.startsWith("--"))
      const points = first === -1 ? rest : rest.slice(0, first)
      return {
        points,
        flags: parseFlags(first === -1 ? [] : rest.slice(first)),
      }
    },
  )
}

if (isMain(import.meta.filename)) {
  runMain(() => main(process.argv.slice(2)))
}

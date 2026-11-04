// The repo's hooks at a flow's points (see config/hooks.ts): which apply,
// running each command with its fix and timeout, and handing prompts and
// exit-2 output to the agent. One call runs its points' lists in order and
// stops at the first task for the agent, so that work lands between the hooks
// around it; `--after` picks the lists back up where it stopped, first running
// a `recheck` hook's command again.
//
// Each command runs detached, in its own process group, with a watchdog that
// kills the group at its timeout. So a call can stop waiting at `--max-wait`
// (a host's limit on one command) and leave the hook running; `--wait` picks
// it back up. A running hook's state and output live in the worktree's own
// git dir, next to the logs: one log per hook, overwritten by its next run.

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { getAt } from "../config/config.ts"
import {
  checkHooks,
  EVALUATE_SCOPES,
  FLOW_RESULTS,
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

/**
 * Seconds past a command's timeout before a job with no result counts as
 * lost (its process group was killed from outside, say), so a wait can't hang.
 */
const LOST_GRACE = 10

export type HookRun = {
  point: string
  name: string
  result: "passed" | "fixed" | "failed" | "timedOut" | "skipped"
  /** Why it was skipped. */
  reason?: string
  /** This run was the recheck after a task the hook handed over. */
  recheck?: boolean
  seconds?: number
  log?: string
  /** The end of a failed command's output. */
  output?: string
}

export type HookReport = {
  /**
   * `done`: every hook ran or was skipped. `agent`: a hook handed the agent a
   * task; run again with `--after <resume>` once it's done. `stop`: a hook
   * failed at a point where that stops the command. `running`: a hook was
   * still running at `--max-wait`; run again with `--wait <resume>`.
   */
  status: "done" | "agent" | "stop" | "running"
  ran: HookRun[]
  /** Failures at points that report them rather than stop. */
  failures: HookRun[]
  agent?: {
    point: string
    name: string
    task: string
    resume: string
    /** The hook runs its command again on `--after`, and still failing stops. */
    recheck?: boolean
  }
  stop?: HookRun
  running?: {
    point: string
    name: string
    resume: string
    /** Seconds it has run so far. */
    seconds: number
    pid?: number
    log: string
  }
  /**
   * At a point whose commands print findings (`evaluate.scan`): what each
   * passing command printed (only the lines its `findings` regex matches,
   * when it has one), for the agent to weigh. Long output is cut to its first
   * lines; the rest stays in `log`.
   */
  findings?: { point: string; name: string; output: string; log: string }[]
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
  /** The branch's issue id, when the flow knows it. */
  issue?: string
  /** This run filed the issue. */
  issueFiled?: boolean
  /** What the flow did, in its own words (`FLOW_RESULTS`). */
  result?: string
  /** The pull request merged (merge), for `on: merged`. */
  merged?: boolean
  /** The commit the merge landed. */
  mergeCommit?: string
  /** The commit the previous recorded evaluation was on (evaluate). */
  since?: string
  /** How much evaluate reviews: full, delta, or carry. */
  scope?: string
  /** The `<point>/<name>` a previous call stopped at. */
  after?: string
  /** The `<point>/<name>` a previous call left running, to wait on. */
  wait?: string
  /** Seconds this call may wait before it leaves a hook running. */
  maxWait?: number
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

/** A command running detached: its files are in `dir`. */
type Job = { dir: string; started: number; timeout: number; pid?: number }

/** One command of a hook: its check, its fix, the check after the fix, or the check after a task. */
type Stage = "run" | "fix" | "rerun" | "recheck"

/** A hook a call stopped waiting on, for `--wait` to pick up. */
type Pending = {
  marker: string
  stage: Stage
  job: Job
  /** The log so far. */
  runs: string[]
  fixed: boolean
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

// Runs `$1/command.sh` with its output in `$1`, and a watchdog that, past `$2`
// seconds, marks it timed out and kills the whole process group (the command's
// children too). On exit, the watchdog is stopped and the status written, last,
// so a status file means the output is complete.
const WRAPPER = `d=$1
sh "$d/command.sh" > "$d/stdout" 2> "$d/stderr" < /dev/null &
c=$!
(
  trap 'kill $s 2>/dev/null; exit 0' TERM
  sleep "$2" & s=$!
  wait $s
  : > "$d/timedout"
  kill -9 0
) &
w=$!
wait $c
code=$?
kill $w 2>/dev/null
echo $code > "$d/exit.tmp" && mv "$d/exit.tmp" "$d/exit"`

function startJob(
  command: string,
  root: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
  dir: string,
): Job {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "command.sh"), command)
  const started = Date.now()
  const child = spawn("sh", ["-c", WRAPPER, "hook", dir, String(timeout)], {
    cwd: root,
    env,
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  return { dir, started, timeout, pid: child.pid }
}

function readOr(file: string): string {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/** The job's result once it has one. */
function pollJob(job: Job): Exec | undefined {
  const file = (name: string) => path.join(job.dir, name)
  const output = () => ({
    stdout: readOr(file("stdout")),
    stderr: readOr(file("stderr")),
  })
  const since = (name: string) =>
    Math.round((fs.statSync(file(name)).mtimeMs - job.started) / 100) / 10
  if (fs.existsSync(file("exit"))) {
    const code = Number(readOr(file("exit")).trim())
    return {
      code: Number.isInteger(code) ? code : null,
      timedOut: false,
      ...output(),
      seconds: since("exit"),
    }
  }
  if (fs.existsSync(file("timedout"))) {
    return { code: null, timedOut: true, ...output(), seconds: job.timeout }
  }
  if (Date.now() > job.started + (job.timeout + LOST_GRACE) * 1000) {
    const { stdout, stderr } = output()
    return {
      code: null,
      timedOut: false,
      stdout,
      stderr: `${stderr}\n[the command's process ended without an exit status]`,
      seconds: Math.round((Date.now() - job.started) / 100) / 10,
    }
  }
  return undefined
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The job's result, or undefined when it's still running at `deadline`. */
function waitJob(job: Job, deadline: number): Exec | undefined {
  // Most hooks are quick: poll often at first, then every half second.
  for (let pause = 20; ; pause = Math.min(pause * 2, 500)) {
    const result = pollJob(job)
    if (result) {
      return result
    }
    const left = deadline - Date.now()
    if (left <= 0) {
      return undefined
    }
    sleep(Math.min(pause, left))
  }
}

/** Lines of a findings command's output printed; the rest stay in its log. */
const FINDINGS_LINES = 400

function head(text: string): string {
  const all = text.split("\n")
  return all.length > FINDINGS_LINES
    ? `${all.slice(0, FINDINGS_LINES).join("\n")}\n[${all.length - FINDINGS_LINES} more line(s) in the log]`
    : text
}

/** What a findings command printed for the reviewer: the lines its `findings` regex matches, else all. */
function findingsOutput(stdout: string, filter: string | undefined): string {
  const printed = stdout.trim()
  if (!filter) {
    return printed
  }
  const pattern = new RegExp(filter)
  return printed
    .split("\n")
    .filter((line) => pattern.test(line))
    .join("\n")
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
  const began = Date.now()
  const deadline =
    request.maxWait === undefined
      ? Number.POSITIVE_INFINITY
      : began + request.maxWait * 1000
  const hooksDir = path.join(
    git(root, ["rev-parse", "--absolute-git-dir"]) ?? path.join(root, ".git"),
    "agent-flows",
    "hooks",
  )
  const logDir = path.join(hooksDir, "logs")
  const runningDir = path.join(hooksDir, "running")
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
    flow: request.flow,
    mode: request.mode,
    outcome: request.outcome,
    merged: request.merged,
    changed: () => context().changed,
  }

  const report: HookReport = { status: "done", ran: [], failures: [] }
  // Hooks up to `--after`'s are done, and up to `--wait`'s too, which then
  // picks up where it was left running.
  const resumeAt = request.wait ?? request.after
  let resuming = resumeAt !== undefined
  for (const point of request.points) {
    const list = getAt(config, point.id)
    for (const hook of Array.isArray(list) ? (list as Hook[]) : []) {
      const marker = `${pointName(point)}/${hook.name}`
      let first: Stage = "run"
      if (resuming) {
        if (marker !== resumeAt) {
          continue
        }
        resuming = false
        if (request.after !== undefined) {
          // The task it handed over is done: a recheck hook checks it.
          if (!(hook.recheck && hook.run !== undefined)) {
            continue
          }
          first = "recheck"
        }
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
        issue: request.issue,
        result: request.result,
        merge: request.mergeCommit,
        since: request.since,
        scope: request.scope,
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
        AGENT_FLOWS_ISSUE: request.issue ?? "",
        AGENT_FLOWS_ISSUE_FILED: request.issueFiled ? "1" : "",
        AGENT_FLOWS_RESULT: request.result ?? "",
        AGENT_FLOWS_MERGED: request.merged ? "1" : "",
        AGENT_FLOWS_MERGE_COMMIT: request.mergeCommit ?? "",
        AGENT_FLOWS_SINCE: request.since ?? "",
        AGENT_FLOWS_SCOPE: request.scope ?? "",
        AGENT_FLOWS_CHANGED_FILES: changedFile,
      }
      const timeout = hook.timeout ?? DEFAULT_TIMEOUT
      const slug = `${pointName(point)}-${hook.name}`
      const log = path.join(logDir, `${slug}.log`)
      const pendingFile = path.join(runningDir, `${slug}.json`)
      const commandOf = (stage: Stage) =>
        (stage === "fix" ? hook.fix : hook.run) as string
      const start = (stage: Stage): Job =>
        startJob(
          fillVars(commandOf(stage), vars),
          root,
          env,
          timeout,
          // Its own dir, so a run an earlier call abandoned can't write into it.
          path.join(runningDir, `${slug}-${stage}-${Date.now()}`),
        )

      // Pick up the run a previous call left, else start one.
      let pending: Pending | undefined
      if (request.wait === marker) {
        try {
          pending = JSON.parse(fs.readFileSync(pendingFile, "utf8")) as Pending
        } catch {
          pending = undefined
        }
      }
      let stage = pending?.stage ?? first
      let job = pending?.job ?? start(stage)
      const runs = pending?.runs ?? []
      let fixed = pending?.fixed ?? false
      let result: Exec
      for (;;) {
        const done = waitJob(job, deadline)
        if (!done) {
          fs.mkdirSync(runningDir, { recursive: true })
          fs.writeFileSync(
            pendingFile,
            JSON.stringify({
              marker,
              stage,
              job,
              runs,
              fixed,
            } satisfies Pending),
          )
          fs.writeFileSync(
            log,
            [
              ...runs,
              `$ ${stage}: ${commandOf(stage)}\n[still running; its output so far is in ${job.dir}]\n`,
            ].join("\n"),
          )
          report.status = "running"
          report.running = {
            ...at,
            resume: marker,
            seconds: Math.round((Date.now() - job.started) / 1000),
            pid: job.pid,
            log,
          }
          return report
        }
        runs.push(
          `$ ${stage === "rerun" ? "run" : stage}: ${commandOf(stage)}\n${done.stdout}${done.stderr}${
            done.timedOut
              ? `\n[timed out after ${timeout}s]\n`
              : `\n[exit ${done.code}]\n`
          }`,
        )
        fs.mkdirSync(logDir, { recursive: true })
        fs.writeFileSync(log, runs.join("\n"))
        fs.rmSync(job.dir, { recursive: true, force: true })
        if (
          stage === "run" &&
          done.code !== 0 &&
          done.code !== 2 &&
          !done.timedOut &&
          !request.noFix &&
          hook.fix
        ) {
          stage = "fix"
        } else if (stage === "fix" && done.code === 0) {
          stage = "rerun"
          fixed = true
        } else {
          result = done
          break
        }
        job = start(stage)
      }
      fs.rmSync(pendingFile, { force: true })

      const seconds = result.seconds
      const recheck = stage === "recheck" ? { recheck: true } : {}
      if (result.code === 0) {
        report.ran.push({
          ...at,
          result: fixed ? "fixed" : "passed",
          ...recheck,
          seconds,
          log,
        })
        const printed = findingsOutput(result.stdout, hook.findings)
        if (point.findings && printed !== "") {
          report.findings ??= []
          report.findings.push({ ...at, output: head(printed), log })
        }
        continue
      }
      // A findings point only reads, so it has no task to hand over, and a
      // recheck that still finds something is a failure.
      if (
        result.code === 2 &&
        !result.timedOut &&
        !point.findings &&
        stage !== "recheck"
      ) {
        report.ran.push({ ...at, result: "passed", seconds, log })
        report.status = "agent"
        report.agent = {
          ...at,
          task:
            result.stderr.trim() ||
            result.stdout.trim() ||
            `The ${hook.name} hook exited 2 with no output; read its log: ${log}`,
          resume: marker,
          ...(hook.recheck ? { recheck: true } : {}),
        }
        return report
      }
      const failed: HookRun = {
        ...at,
        result: result.timedOut ? "timedOut" : "failed",
        ...recheck,
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
      `no hook ${resumeAt} at ${request.points.map(pointName).join(", ")}`,
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

/** The flags that take no value. */
const SWITCHES = new Set(["issue-filed", "merged"])

/** The flags `run` and `try` take, besides the switches and the points. */
export function checkFlags(flags: Map<string, string>, flow: string): void {
  const result = flags.get("result")
  if (result !== undefined) {
    const results = FLOW_RESULTS[flow]
    if (!results) {
      throw new UsageError(
        `--result is only for ${Object.keys(FLOW_RESULTS).join(", ")}`,
      )
    }
    if (!results.includes(result)) {
      throw new UsageError(`--result for ${flow} must be ${results.join(", ")}`)
    }
  }
  const scope = flags.get("scope")
  if (
    scope !== undefined &&
    !(EVALUATE_SCOPES as readonly string[]).includes(scope)
  ) {
    throw new UsageError(`--scope must be ${EVALUATE_SCOPES.join(", ")}`)
  }
  if (flags.has("merged") && flow !== "merge") {
    throw new UsageError("--merged is only for merge")
  }
  if (flags.has("after") && flags.has("wait")) {
    throw new UsageError(
      "pass --after (a task is done) or --wait (a hook is running), not both",
    )
  }
  const maxWait = flags.get("max-wait")
  if (maxWait !== undefined) {
    const n = Number(maxWait)
    if (!Number.isFinite(n) || n <= 0) {
      throw new UsageError("--max-wait takes a number of seconds")
    }
  }
}

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
  checkFlags(args.flags, flow)
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
  const maxWait = args.flags.get("max-wait")
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
      issue: args.flags.get("issue"),
      issueFiled: args.flags.has("issue-filed"),
      result: args.flags.get("result"),
      merged: args.flags.has("merged"),
      mergeCommit: args.flags.get("merge-commit"),
      since: args.flags.get("since"),
      scope: args.flags.get("scope"),
      after: args.flags.get("after"),
      wait: args.flags.get("wait"),
      maxWait: maxWait === undefined ? undefined : Number(maxWait),
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
  const { paths: _paths, flows: _flows, modes: _modes, on: _on, ...bare } = hook
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
      \`merge.after\`). Prints JSON: \`status\` (done, agent, stop, or
      running), \`ran\` (each hook's result: passed, fixed, failed, timedOut,
      or skipped and why), \`failures\` (at points that report rather than
      stop), \`agent\` (a task for the agent: a prompt, or what a command
      printed when it exited 2; run again with --after <its resume> once
      it's done, which first runs a \`recheck\` hook's command again),
      \`stop\` (the hook that failed), and \`running\` (a hook still running
      at --max-wait; run again with --wait <its resume>).

  try <point>     Try one hook that isn't configured yet, given as JSON, at
      a point before the work (not an after point: those can have side
      effects). Ignores its paths, flows, modes, and on, and doesn't run its
      fix. Prints the same JSON as run, plus \`fix\` when a fix wasn't run.

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
  --issue <id>           The branch's issue, for {issue}
  --issue-filed          This run filed that issue (AGENT_FLOWS_ISSUE_FILED=1)
  --result <result>      What the flow did, for {result} (sync: ${FLOW_RESULTS.sync?.join(", ")})
  --merged               The pull request merged (merge), for \`on: merged\`
  --merge-commit <sha>   The commit the merge landed, for {merge}
  --since <sha>          The previous recorded evaluation's commit, for {since}
  --scope <scope>        What evaluate reviews (${EVALUATE_SCOPES.join(", ")}), for {scope}
  --after <point>/<name> Go on after this hook, where a call stopped
  --wait <point>/<name>  Wait on this hook, where a call left it running
  --max-wait <seconds>   Stop waiting after this long, leaving the hook
                         running (status running), for a host that limits
                         how long one command runs

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
        flags: parseFlags(first === -1 ? [] : rest.slice(first), SWITCHES),
      }
    },
  )
}

if (isMain(import.meta.filename)) {
  runMain(() => main(process.argv.slice(2)))
}

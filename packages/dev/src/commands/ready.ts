// The ready flow's deterministic parts: what the branch touches, so local
// checks stay scoped to it, and the CI passes after each push, so settling,
// the timeout, and the stall guard read the same on every host.
//
// CI state lives in the repo's git common dir, one file per branch, like
// sync's, so a pass started in one worktree is the same pass in another.
// Check logs go in the worktree's own git dir.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {
  CHECK_STATES,
  type Check,
  type CheckState,
} from "../config/adapters/checks.ts"
import { matchingRules } from "../config/rules.ts"
import { loadConfig, repoRoot } from "./configure.ts"
import {
  isMain,
  parseFlags,
  printJson,
  readJson,
  readStdin,
  requiredFlag,
  run,
  runMain,
  USAGE_EXIT,
  UsageError,
} from "./lib.ts"
import { readBranchState, writeBranchState } from "./sync.ts"

/** How long a pass waits for its checks to settle. */
export const DEFAULT_TIMEOUT = 900

/** How often `ci wait` asks for the checks. */
export const DEFAULT_INTERVAL = 30

/**
 * How long a pushed commit may show no checks at all before ready takes it
 * that the repo runs none on it, rather than that they haven't started.
 */
export const NO_CHECKS_GRACE = 180

/** Passes kept per branch; older ones only matter to the stall guard. */
const KEPT_PASSES = 20

// --- git ---------------------------------------------------------------------

function git(args: string[], cwd?: string): string | undefined {
  const result = run("git", args, cwd)
  return result.status === 0 ? result.stdout.trim() : undefined
}

function lines(text: string | undefined): string[] {
  return (text ?? "").split("\n").filter(Boolean)
}

function gitPath(flag: string): string {
  const dir = git(["rev-parse", "--path-format=absolute", flag])
  if (!dir) {
    throw new Error("not inside a git repository")
  }
  return dir
}

function currentBranch(): string {
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"])
  if (!branch) {
    throw new UsageError("HEAD is detached: check out a branch first")
  }
  return branch
}

function refExists(ref: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", ref]) !== undefined
}

// --- plan --------------------------------------------------------------------

/** Files that make a directory a package, for the languages ready knows. */
export const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "mix.exs",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]

/** Package scripts that fix or check code, by name (`lint`, `test:unit`). */
export const CHECK_SCRIPT =
  /^(lint|format|fmt|fix|check|checks|validate|verify|typecheck|type-check|types|tsc|test|tests|build|knip)([:-].*)?$/

/** The files agents read for a directory's rules. */
export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"]

const LOCKFILES: [string, string][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
]

export type Package = {
  /** Repo-relative, `.` for the root. */
  dir: string
  manifest: string
  /** How to run a script: `bun run`, `pnpm run`, … (JavaScript only). */
  run?: string
  /** Scripts that fix or check code, name → command (JavaScript only). */
  scripts?: Record<string, string>
  /** Changed files in it. */
  changed: number
}

/** Each directory from `dir` up to the root, `dir` first; `.` is the root. */
function ancestors(dir: string): string[] {
  const out: string[] = []
  let current = dir
  while (current && current !== "." && current !== "/") {
    out.push(current)
    current = path.posix.dirname(current)
  }
  out.push(".")
  return out
}

function packageManager(
  root: string,
  dir: string,
  manifest: Record<string, unknown>,
): string {
  for (const candidate of ancestors(dir)) {
    for (const [lockfile, tool] of LOCKFILES) {
      if (fs.existsSync(path.join(root, candidate, lockfile))) {
        return tool
      }
    }
  }
  const declared =
    typeof manifest.packageManager === "string"
      ? manifest.packageManager.split("@")[0]
      : undefined
  return declared && ["bun", "pnpm", "yarn", "npm"].includes(declared)
    ? declared
    : "npm"
}

function readPackage(root: string, dir: string, manifest: string): Package {
  const pkg: Package = { dir, manifest, changed: 0 }
  if (manifest !== "package.json") {
    return pkg
  }
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(root, dir, manifest), "utf8"),
    ) as Record<string, unknown>
  } catch {
    return pkg
  }
  const scripts =
    parsed.scripts && typeof parsed.scripts === "object"
      ? (parsed.scripts as Record<string, unknown>)
      : {}
  pkg.run = `${packageManager(root, dir, parsed)} run`
  pkg.scripts = Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] =>
        CHECK_SCRIPT.test(entry[0]) && typeof entry[1] === "string",
    ),
  )
  return pkg
}

/**
 * The package each changed file belongs to: the nearest directory above it
 * with a manifest. A file under no package (a root README with no root
 * manifest) belongs to none.
 */
export function touchedPackages(root: string, files: string[]): Package[] {
  const found = new Map<string, Package>()
  for (const file of files) {
    for (const dir of ancestors(path.posix.dirname(file))) {
      const manifest = MANIFESTS.find((name) =>
        fs.existsSync(path.join(root, dir, name)),
      )
      if (manifest) {
        const pkg = found.get(dir) ?? readPackage(root, dir, manifest)
        pkg.changed++
        found.set(dir, pkg)
        break
      }
    }
  }
  return [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * Agent instruction files at the root and above every changed file, then the
 * path-scoped rule files (`.claude/rules`, `.cursor/rules`) whose globs match
 * a changed file.
 */
export function instructionFiles(root: string, files: string[]): string[] {
  const dirs = new Set(
    files.flatMap((file) => ancestors(path.posix.dirname(file))),
  )
  dirs.add(".")
  const always = [...dirs]
    .flatMap((dir) =>
      INSTRUCTION_FILES.map((name) => path.posix.join(dir, name)),
    )
    .filter((file) => fs.existsSync(path.join(root, file)))
    .sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    )
  return [...always, ...matchingRules(root, [...dirs], files)]
}

export type ReadyCommands = {
  /** True when the config's `ready` section sets either list. */
  configured: boolean
  fix: string[]
  checks: string[]
}

/** The config's `ready` section, with `{base}` the merge base. */
export function readyCommands(
  config: Record<string, unknown> | undefined,
  mergeBase: string,
): ReadyCommands {
  const section =
    config?.ready && typeof config.ready === "object"
      ? (config.ready as Record<string, unknown>)
      : {}
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.replaceAll("{base}", mergeBase))
      : []
  const fix = list(section.fix)
  const checks = list(section.checks)
  return { configured: fix.length + checks.length > 0, fix, checks }
}

/** The steps ready can skip, in the order it reaches them. */
export const READY_STEPS = [
  "cleanup",
  "tests",
  "fix",
  "checks",
  "ci",
  "reviews",
] as const

export type ReadyStep = (typeof READY_STEPS)[number]

/** Shorthand for every local step, and for every step. */
const STEP_GROUPS: Record<string, ReadyStep[]> = {
  local: ["cleanup", "tests", "fix", "checks"],
  all: [...READY_STEPS],
}

export type ReadySkips = {
  /** The steps this run skips: the config's, plus the run's own. */
  skip: ReadyStep[]
  /** CI check name patterns this run neither waits on nor fixes. */
  ignoreChecks: string[]
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

/**
 * The config's `ready.skip` and `ready.ignoreChecks`, with the run's own
 * `--skip` and `--ignore-check` added. A step it doesn't know is an error, so
 * a typo can't quietly run the step it meant to skip.
 */
export function readySkips(
  config: Record<string, unknown> | undefined,
  run: { skip?: string[]; ignoreChecks?: string[] } = {},
): ReadySkips {
  const section =
    config?.ready && typeof config.ready === "object"
      ? (config.ready as Record<string, unknown>)
      : {}
  const named = [...stringList(section.skip), ...(run.skip ?? [])]
    .flatMap((item) => item.split(","))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  const steps = new Set<ReadyStep>()
  for (const name of named) {
    const group = STEP_GROUPS[name]
    if (group) {
      for (const step of group) {
        steps.add(step)
      }
    } else if ((READY_STEPS as readonly string[]).includes(name)) {
      steps.add(name as ReadyStep)
    } else {
      throw new UsageError(
        `ready can't skip \`${name}\`: it skips ${READY_STEPS.join(", ")}, local (the first four), or all`,
      )
    }
  }
  return {
    skip: READY_STEPS.filter((step) => steps.has(step)),
    ignoreChecks: [
      ...new Set([
        ...stringList(section.ignoreChecks),
        ...(run.ignoreChecks ?? []),
      ]),
    ],
  }
}

/** `origin/<base>` when it exists, so a stale local base doesn't widen the diff. */
function resolveBase(base: string): string {
  if (refExists(`refs/remotes/origin/${base}`)) {
    return `origin/${base}`
  }
  if (refExists(base)) {
    return base
  }
  throw new UsageError(`no branch or ref \`${base}\` (fetch it first?)`)
}

function plan(args: string[]): void {
  const { values: skip, rest: afterSkip } = takeRepeated(args, "skip")
  const { values: ignoreChecks, rest } = takeRepeated(afterSkip, "ignore-check")
  const flags = parseFlags(rest)
  const base = requiredFlag(flags, "base")
  const root = gitPath("--show-toplevel")
  // Read first, so a step it can't skip stops the plan before the fetch.
  const config = loadConfig(root).config
  readySkips(config, { skip, ignoreChecks })
  // A stacked parent may exist only locally, so a failed fetch isn't fatal.
  const fetched = run("git", ["fetch", "--quiet", "origin", base]).status === 0
  const baseRef = resolveBase(base)
  const mergeBase = git(["merge-base", baseRef, "HEAD"])
  if (!mergeBase) {
    throw new UsageError(`HEAD has no merge base with ${baseRef}`)
  }
  const committed = lines(git(["diff", "--name-only", mergeBase, "HEAD"]))
  const uncommitted = lines(git(["diff", "--name-only", "HEAD"]))
  const untracked = lines(git(["ls-files", "--others", "--exclude-standard"]))
  const changed = [
    ...new Set([...committed, ...uncommitted, ...untracked]),
  ].sort()
  const logDir = path.join(
    gitPath("--absolute-git-dir"),
    "agent-flows",
    "ready",
    "logs",
  )
  fs.mkdirSync(logDir, { recursive: true })
  printJson({
    branch: currentBranch(),
    baseRef,
    fetched,
    mergeBase,
    ahead: Number(git(["rev-list", "--count", `${baseRef}..HEAD`]) ?? 0),
    dirty: uncommitted.length + untracked.length > 0,
    changed,
    committed: committed.length,
    uncommitted: uncommitted.length,
    untracked: untracked.length,
    packages: touchedPackages(root, changed),
    instructions: instructionFiles(root, changed),
    commands: readyCommands(config, mergeBase),
    ...readySkips(config, { skip, ignoreChecks }),
    logDir,
  })
}

// --- CI passes ---------------------------------------------------------------

/** One pushed commit's CI run, as ready has seen it. */
export type Pass = {
  sha: string
  startedAt: string
  /** Checks the push meant to fix, which failing again means the fix didn't work. */
  fixed: string[]
  /** Failures already reported, so each is reported new only once. */
  seen: string[]
  /** The failures once every check settled. */
  settled?: string[]
}

export type ReadyState = { passes: Pass[] }

export type CiReport = {
  sha: string
  /** 1 for the first pushed commit this branch's ready waited on. */
  pass: number
  elapsedSeconds: number
  timeoutSeconds: number
  /** Every check reached pass, fail, skipping, or cancelled. */
  settled: boolean
  /** Not settled, and the pass has waited its timeout. */
  timedOut: boolean
  /** Settled, with at least one check and every one passing or skipping. */
  green: boolean
  /** No check reported within the grace period: the repo runs none here. */
  noChecks: boolean
  counts: Record<CheckState, number>
  pending: string[]
  failures: Check[]
  /** Failures not reported by an earlier record of this pass. */
  newFailures: Check[]
  /** Failures of checks the push meant to fix. */
  stalled: string[]
  /** Checks left out by an ignore pattern: not waited on, never failures. */
  ignored: string[]
  /** With `requiredOnly`, checks the base doesn't require: not waited on, never failures. */
  optional: string[]
}

/** A check name pattern, where `*` is any run of characters, case aside. */
export function matchesCheck(name: string, pattern: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${source}$`, "i").test(name)
}

/** Start (or restart) the pass for a pushed commit. */
export function startPass(
  state: ReadyState,
  sha: string,
  fixed: string[],
  now: Date,
): ReadyState {
  const passes = [...state.passes]
  const last = passes.at(-1)
  const pass: Pass = {
    sha,
    startedAt: now.toISOString(),
    fixed: last?.sha === sha ? [...new Set([...last.fixed, ...fixed])] : fixed,
    seen: [],
  }
  if (last?.sha === sha) {
    passes[passes.length - 1] = pass
  } else {
    passes.push(pass)
  }
  return { passes: passes.slice(-KEPT_PASSES) }
}

function isFailure(check: Check): boolean {
  return check.state === "fail" || check.state === "cancelled"
}

/** Fold a snapshot of a commit's checks into its pass, and say where it stands. */
export function recordChecks(
  state: ReadyState,
  sha: string,
  all: Check[],
  now: Date,
  timeoutSeconds = DEFAULT_TIMEOUT,
  ignore: string[] = [],
  /** Wait only on checks the base requires, when the checks say which. */
  requiredOnly = false,
): { state: ReadyState; report: CiReport } {
  const ignored = all.filter((check) =>
    ignore.some((pattern) => matchesCheck(check.name, pattern)),
  )
  const kept = all.filter((check) => !ignored.includes(check))
  // A host that couldn't say which checks are required leaves them all in.
  const optional =
    requiredOnly && kept.some((check) => check.required !== undefined)
      ? kept.filter((check) => check.required !== true)
      : []
  const checks = kept.filter((check) => !optional.includes(check))
  let next = state
  if (next.passes.at(-1)?.sha !== sha) {
    next = startPass(next, sha, [], now)
  }
  const passes = [...next.passes]
  const index = passes.length - 1
  const pass = { ...passes[index] }
  const elapsedSeconds = Math.max(
    0,
    Math.round((now.getTime() - Date.parse(pass.startedAt)) / 1000),
  )
  const pending = checks.filter((check) => check.state === "pending")
  // Every check reported is ignored or optional: nothing left to wait for.
  const noChecks =
    checks.length === 0 &&
    (ignored.length + optional.length > 0 ||
      elapsedSeconds >= Math.min(NO_CHECKS_GRACE, timeoutSeconds))
  const settled = noChecks || (checks.length > 0 && pending.length === 0)
  const failures = checks.filter(isFailure)
  const newFailures = failures.filter(
    (check) => !pass.seen.includes(check.name),
  )
  pass.seen = [
    ...new Set([...pass.seen, ...failures.map((check) => check.name)]),
  ]
  if (settled) {
    pass.settled = failures.map((check) => check.name)
  }
  passes[index] = pass
  const counts = Object.fromEntries(
    CHECK_STATES.map((s) => [
      s,
      checks.filter((check) => check.state === s).length,
    ]),
  ) as Record<CheckState, number>
  return {
    state: { passes },
    report: {
      sha,
      pass: index + 1,
      elapsedSeconds,
      timeoutSeconds,
      settled,
      timedOut: !settled && elapsedSeconds >= timeoutSeconds,
      green: settled && !noChecks && failures.length === 0,
      noChecks,
      counts,
      pending: pending.map((check) => check.name),
      failures,
      newFailures,
      stalled: failures
        .map((check) => check.name)
        .filter((name) => pass.fixed.includes(name)),
      ignored: ignored.map((check) => check.name),
      optional: optional.map((check) => check.name),
    },
  }
}

/** A `checks` op's output: `{"checks": [...]}`, or the bare list. */
export function parseChecks(text: string): Check[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UsageError("the checks aren't JSON")
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { checks?: unknown } | null)?.checks
  if (!Array.isArray(list)) {
    throw new UsageError('expected {"checks": [...]}')
  }
  return list.map((item, i) => {
    const check = item as Partial<Check>
    if (
      typeof check.name !== "string" ||
      !CHECK_STATES.includes(check.state as CheckState)
    ) {
      throw new UsageError(
        `check ${i} needs a \`name\` and a \`state\` (${CHECK_STATES.join(", ")})`,
      )
    }
    return {
      name: check.name,
      state: check.state as CheckState,
      ...(typeof check.link === "string" ? { link: check.link } : {}),
      ...(check.log !== undefined && check.log !== null
        ? { log: String(check.log) }
        : {}),
      ...(typeof check.required === "boolean"
        ? { required: check.required }
        : {}),
    }
  })
}

function stateDir(): string {
  return path.join(gitPath("--git-common-dir"), "agent-flows", "ready")
}

function readState(dir: string, branch: string): ReadyState {
  const stored = readBranchState<ReadyState>(dir, branch)
  return { passes: Array.isArray(stored?.passes) ? stored.passes : [] }
}

function numberFlag(
  flags: Map<string, string>,
  name: string,
  fallback: number,
): number {
  const value = flags.get(name)
  if (value === undefined) {
    return fallback
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`--${name} takes a number of seconds`)
  }
  return n
}

/** A flag that may repeat (`--fixed`), so it's taken out before the other flags are parsed. */
function takeRepeated(
  args: string[],
  name: string,
): { values: string[]; rest: string[] } {
  const values: string[] = []
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] !== undefined) {
      values.push(args[++i])
    } else {
      rest.push(args[i])
    }
  }
  return { values, rest }
}

function ciStart(args: string[]): void {
  const { values: fixed, rest } = takeRepeated(args, "fixed")
  const flags = parseFlags(rest)
  const sha = requiredFlag(flags, "sha")
  const dir = stateDir()
  const branch = currentBranch()
  const state = startPass(readState(dir, branch), sha, fixed, new Date())
  writeBranchState(dir, branch, state)
  const pass = state.passes.at(-1) as Pass
  printJson({
    sha,
    pass: state.passes.length,
    fixed: pass.fixed,
    startedAt: pass.startedAt,
  })
}

/** `--required-only` takes no value, so it comes out before the flags are parsed. */
function takeSwitch(args: string[], name: string) {
  return {
    on: args.includes(`--${name}`),
    rest: args.filter((a) => a !== `--${name}`),
  }
}

async function ciRecord(args: string[]): Promise<void> {
  const { values: ignore, rest: afterIgnore } = takeRepeated(
    args,
    "ignore-check",
  )
  const { on: requiredOnly, rest } = takeSwitch(afterIgnore, "required-only")
  const flags = parseFlags(rest)
  const sha = requiredFlag(flags, "sha")
  const file = flags.get("file")
  const checks = parseChecks(
    file ? JSON.stringify(readJson(file)) : await readStdin(),
  )
  const dir = stateDir()
  const branch = currentBranch()
  const { state, report } = recordChecks(
    readState(dir, branch),
    sha,
    checks,
    new Date(),
    numberFlag(flags, "timeout", DEFAULT_TIMEOUT),
    ignore,
    requiredOnly,
  )
  writeBranchState(dir, branch, state)
  printJson(report)
}

function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`
}

/** One line of progress for stderr. */
export function progressLine(report: CiReport): string {
  const total = Object.values(report.counts).reduce((a, b) => a + b, 0)
  const waiting =
    report.pending.length > 0
      ? `, ${report.pending.length} pending (${report.pending.slice(0, 5).join(", ")}${report.pending.length > 5 ? ", …" : ""})`
      : ""
  const ignored =
    report.ignored.length > 0 ? `, ${report.ignored.length} ignored` : ""
  const optional =
    report.optional.length > 0 ? `, ${report.optional.length} not required` : ""
  return `[ready-ci] pass ${report.pass}, ${minutes(report.elapsedSeconds)} of ${minutes(report.timeoutSeconds)}: ${total} checks, ${report.counts.fail + report.counts.cancelled} failed${waiting}${ignored}${optional}`
}

async function ciWait(args: string[]): Promise<void> {
  const { values: ignore, rest: afterIgnore } = takeRepeated(
    args,
    "ignore-check",
  )
  const { on: requiredOnly, rest } = takeSwitch(afterIgnore, "required-only")
  const flags = parseFlags(rest)
  const sha = requiredFlag(flags, "sha")
  const command = requiredFlag(flags, "command")
  const timeout = numberFlag(flags, "timeout", DEFAULT_TIMEOUT)
  const interval = numberFlag(flags, "interval", DEFAULT_INTERVAL)
  const maxWait = numberFlag(flags, "max-wait", Number.POSITIVE_INFINITY)
  const dir = stateDir()
  const branch = currentBranch()
  const began = Date.now()
  let errors = 0
  for (;;) {
    const result = spawnSync("sh", ["-c", command], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
    let checks: Check[] | undefined
    if (result.status === 0) {
      try {
        checks = parseChecks(result.stdout)
      } catch (error) {
        console.error(
          `[ready-ci] ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } else {
      console.error(
        `[ready-ci] the checks command failed: ${(result.stderr || result.stdout).trim().slice(-500)}`,
      )
    }
    if (!checks) {
      // A blip (rate limit, network) shouldn't end the wait; three in a row should.
      if (++errors >= 3) {
        console.error("[ready-ci] giving up after 3 failed reads in a row")
        process.exitCode = 1
        return
      }
    } else {
      errors = 0
      const { state, report } = recordChecks(
        readState(dir, branch),
        sha,
        checks,
        new Date(),
        timeout,
        ignore,
        requiredOnly,
      )
      writeBranchState(dir, branch, state)
      for (const check of report.newFailures) {
        console.error(
          `[ready-ci] ${check.state === "cancelled" ? "cancelled" : "failed"}: ${check.name}${check.link ? ` (${check.link})` : ""}`,
        )
      }
      console.error(progressLine(report))
      const waitedOut = (Date.now() - began) / 1000 + interval > maxWait
      if (report.settled || report.timedOut || waitedOut) {
        printJson(report)
        return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval * 1000))
  }
}

const USAGE = `Usage: ready.ts <subcommand> [flags]

  plan --base <branch> [--skip <step>[,<step>]]... [--ignore-check <pattern>]...
      What the branch touches against <branch> (fetched from origin first):
      the merge base, changed files (committed, uncommitted, untracked), the
      package each belongs to with its check scripts, the agent instruction
      files above them and the path-scoped rule files (.claude/rules,
      .cursor/rules) that match them, the config's ready commands, and a
      log dir. Also the
      steps to skip (${READY_STEPS.join(", ")}, local for the first four, or
      all)
      and the CI checks to ignore: the config's, plus these flags'.

  instructions --files <file>
      The agent instruction and matching rule files for the repo-relative
      paths in <file> (one per line), as JSON, the same way plan finds them.

  ci start --sha <sha> [--fixed <check>]...
      Start the CI pass for a pushed commit. --fixed names each check the
      push meant to fix, so its failing again reads as stalled.

  ci record --sha <sha> [--file <checks.json>] [--timeout <seconds>] [--ignore-check <pattern>]... [--required-only]
      Fold one snapshot of the commit's checks (the checks op's JSON, from
      the file or stdin) into its pass, and print where it stands: settled,
      timedOut, green, noChecks, counts, pending, failures, newFailures,
      stalled, ignored, and optional. A check whose name matches an
      --ignore-check pattern (\`*\` is any run of characters) isn't waited on
      or failed. With --required-only, neither is a check whose \`required\`
      is false (the checks op was given the base); when no check says, all
      count.

  ci wait --sha <sha> --command <cmd> [--interval <s>] [--timeout <s>] [--max-wait <s>] [--ignore-check <pattern>]... [--required-only]
      Run <cmd> (it prints the checks op's JSON) every --interval seconds
      (${DEFAULT_INTERVAL}), recording each, until the pass settles or has waited --timeout
      seconds (${DEFAULT_TIMEOUT}) since \`ci start\`; --max-wait returns sooner, for a
      host that limits how long a command runs. Progress and each new failure
      go to stderr; the last record's report to stdout. --ignore-check and
      --required-only as for record.

A pass's state is kept per branch in the repo's git common dir.`

/** The instruction and rule files for a list of changed files, for a flow with its own diff. */
function instructions(args: string[]): void {
  const flags = parseFlags(args)
  const listed = fs
    .readFileSync(requiredFlag(flags, "files"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  printJson({ instructions: instructionFiles(repoRoot(), listed) })
}

export async function main(argv: string[]): Promise<void> {
  const [command, sub, ...rest] = argv
  try {
    if (command === "instructions") {
      instructions([sub, ...rest].filter((a) => a !== undefined))
    } else if (command === "plan") {
      plan([sub, ...rest].filter((a) => a !== undefined))
    } else if (command === "ci" && sub === "start") {
      ciStart(rest)
    } else if (command === "ci" && sub === "record") {
      await ciRecord(rest)
    } else if (command === "ci" && sub === "wait") {
      await ciWait(rest)
    } else {
      console.log(USAGE)
      process.exitCode = !command || command === "help" ? 0 : 1
    }
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error
    }
    console.error(error.message)
    process.exitCode = USAGE_EXIT
  }
}

if (isMain(import.meta.filename)) {
  runMain(() => main(process.argv.slice(2)))
}

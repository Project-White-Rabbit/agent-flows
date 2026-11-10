// The mechanical half of evaluate's record: which files a review covers, the
// verdict recorded for a branch, and the gate merge reads. The judging stays
// in the skill; this keeps what it judged (each file's change, by patch-id)
// so a later run reviews only what moved, and so merge can tell a verdict on
// the commit it lands from one on an older commit.
//
// Records live in the repo's git common dir, one file per branch, beside
// sync's state: never in the tree, and shared by the repo's worktrees.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { getAt } from "../config/config.ts"
import { loadConfig } from "./configure.ts"
import {
  isMain,
  parseFlags,
  printJson,
  requiredFlag,
  runMain,
  runSubcommand,
  stateDir,
  UsageError,
} from "./lib.ts"
import { fillCommand, shellQuote } from "./ready.ts"
import { readBranchState, writeBranchState } from "./sync.ts"

export const VERDICTS = ["pass", "flag", "stop"] as const
export type Verdict = (typeof VERDICTS)[number]

export const SCOPES = ["full", "delta", "carry"] as const
export type Scope = (typeof SCOPES)[number]

export type EvaluationRecord = {
  branch: string
  /** The commit the verdict is on. */
  sha: string
  verdict: Verdict
  /**
   * The verdict's line first, then one line per finding, each ending in its
   * anchor: ` @ <path>[:<line>]`, several paths comma-separated (see
   * `findingAnchors`).
   */
  summary: string[]
  /** Each file the branch changes, by its change's patch-id. */
  files: Record<string, string>
  /** How the verdict was reached: a full review, a delta, or carried over. */
  scope: Scope
  /** The commit a carried or delta verdict started from. */
  carriedFrom?: string
  recordedAt: string
}

export type Settings = {
  record: boolean
  scope: "full" | "delta"
  reviewer: "session" | "subagent"
  /** `rethink`: only a Rethink records stop. `high`: so does a confirmed HIGH risk or STOP scan finding. */
  stopOn: "rethink" | "high"
  /** Fetch origin/<base> before diffing against it. */
  fetch: boolean
  /** Repo-relative files pasted into the judging prompt as an extra lens. */
  instructions: string[]
  /** The command that runs the relevant tests, `{tests}` for the files. */
  tests: string | null
  requireEvaluation: "pass" | "flag" | null
}

function git(root: string, args: string[], input?: string): string | undefined {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  })
  return result.status === 0 ? result.stdout : undefined
}

function lines(text: string | undefined): string[] {
  return (text ?? "").split("\n").filter(Boolean)
}

export function settings(config: Record<string, unknown>): Settings {
  const at = (key: string) => getAt(config, key)
  return {
    record: at("evaluate.record") === true,
    scope: at("evaluate.scope") === "delta" ? "delta" : "full",
    reviewer: at("evaluate.reviewer") === "subagent" ? "subagent" : "session",
    stopOn: at("evaluate.stopOn") === "high" ? "high" : "rethink",
    fetch: at("evaluate.fetch") === true,
    instructions: Array.isArray(at("evaluate.instructions"))
      ? (at("evaluate.instructions") as unknown[]).filter(
          (file): file is string => typeof file === "string",
        )
      : [],
    tests:
      typeof at("evaluate.tests") === "string"
        ? (at("evaluate.tests") as string)
        : null,
    requireEvaluation:
      at("merge.requireEvaluation") === "pass" ||
      at("merge.requireEvaluation") === "flag"
        ? (at("merge.requireEvaluation") as "pass" | "flag")
        : null,
  }
}

export function recordDir(root: string): string {
  return stateDir("evaluate", { cwd: root, shared: true })
}

function currentBranch(root: string): string {
  const branch = git(root, ["branch", "--show-current"])?.trim()
  if (!branch) {
    throw new UsageError("HEAD is detached: check out a branch")
  }
  return branch
}

function head(root: string): string {
  const sha = git(root, ["rev-parse", "HEAD"])?.trim()
  if (!sha) {
    throw new UsageError("no commit at HEAD")
  }
  return sha
}

export function mergeBase(root: string, base: string): string {
  const sha = git(root, ["merge-base", base, "HEAD"])?.trim()
  if (!sha) {
    throw new UsageError(`no merge base between ${base} and HEAD`)
  }
  return sha
}

/**
 * Each file the branch changes against `base` (a merge base), working tree
 * included, by the patch-id of its change without context lines: line
 * numbers don't count either, so the base moving lines around the branch's
 * change leaves the id alone. Untracked files hash their content.
 */
export function fileChanges(
  root: string,
  base: string,
): Record<string, string> {
  const files: Record<string, string> = {}
  for (const file of lines(
    git(root, ["-c", "core.quotePath=false", "diff", "--name-only", base]),
  )) {
    const diff =
      git(root, ["diff", "--binary", "--unified=0", base, "--", file]) ?? ""
    const id = lines(git(root, ["patch-id", "--stable"], diff))[0]?.split(
      " ",
    )[0]
    files[file] = id ?? `sha1:${createHash("sha1").update(diff).digest("hex")}`
  }
  for (const file of lines(
    git(root, [
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--others",
      "--exclude-standard",
    ]),
  )) {
    const content = fs.readFileSync(path.join(root, file))
    files[file] =
      `untracked:${createHash("sha1").update(content).digest("hex")}`
  }
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  )
}

/** The files whose change differs from the record's, and the record's no longer changed. */
export function moved(
  now: Record<string, string>,
  then: Record<string, string>,
): { review: string[]; dropped: string[] } {
  return {
    review: Object.keys(now).filter((file) => now[file] !== then[file]),
    dropped: Object.keys(then).filter((file) => !(file in now)),
  }
}

export function worse(a: Verdict, b: Verdict): Verdict {
  return VERDICTS.indexOf(a) >= VERDICTS.indexOf(b) ? a : b
}

/** Where a finding's anchor starts: the last ` @ ` in its line. */
const ANCHOR = /\s@\s+([^@]+)$/

/**
 * The files a summary line's finding is anchored in: what follows its last
 * ` @ `, comma-separated, each a repo-relative path with an optional
 * `:<line>` or `:<line>-<line>`. Empty for a line with no anchor (the
 * verdict's line, or a finding nothing in the tree locates).
 *
 *     [HIGH] Migration: drops a column old code reads. @ db/schema.ts:12, api/x.ts
 *     -> ["db/schema.ts", "api/x.ts"]
 */
export function findingAnchors(line: string): string[] {
  const match = ANCHOR.exec(line.trimEnd())
  if (!match?.[1]) {
    return []
  }
  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/:\d+(-\d+)?$/, ""))
    .filter(Boolean)
}

/**
 * A delta's record: its own lines, then the previous findings it didn't
 * re-check. A previous finding is dropped when every file it's anchored in
 * was re-reviewed (or the branch no longer changes it), since the reviewer
 * judged those files again; one anchored in any file left alone, or with no
 * anchor at all, still stands. The previous verdict's line (its first) is
 * replaced by the new one. The verdict is the new one, made worse only by
 * what still stands: the previous verdict when any of its findings do.
 */
export function combineDelta(
  previous: Pick<EvaluationRecord, "verdict" | "summary">,
  next: { verdict: Verdict; summary: string[] },
  rechecked: string[],
): { verdict: Verdict; summary: string[]; kept: string[] } {
  const covered = new Set(rechecked)
  const kept = previous.summary.slice(1).filter((line) => {
    const anchors = findingAnchors(line)
    return (
      !next.summary.includes(line) &&
      (anchors.length === 0 || anchors.some((file) => !covered.has(file)))
    )
  })
  return {
    verdict: worse(next.verdict, kept.length > 0 ? previous.verdict : "pass"),
    summary: [...next.summary, ...kept],
    kept,
  }
}

/** A finding line that records stop at `evaluate.stopOn: high`. */
export function stopsAtHigh(line: string): boolean {
  return /^\[(HIGH|STOP)\]/i.test(line.trim())
}

export function readRecord(
  root: string,
  branch: string,
): EvaluationRecord | undefined {
  const record = readBranchState<EvaluationRecord>(recordDir(root), branch)
  return record &&
    typeof record.sha === "string" &&
    (VERDICTS as readonly string[]).includes(record.verdict) &&
    record.branch === branch
    ? record
    : undefined
}

function writeRecord(root: string, record: EvaluationRecord): void {
  writeBranchState(
    recordDir(root),
    record.branch,
    record,
    (branch) =>
      git(root, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]) !== undefined,
  )
}

export type ScopeReport = {
  branch: string
  head: string
  mergeBase: string
  settings: Settings
  /** `full`: review every file. `delta`: only `review`. `carry`: nothing moved, keep the verdict. */
  scope: Scope
  files: string[]
  review: string[]
  dropped: string[]
  previous: EvaluationRecord | null
  /**
   * The commit a `delta` or `carry` starts from (the recorded verdict's), for
   * a scan of only what moved since; null for a `full` review.
   */
  since: string | null
  why: string
}

export type ScopeOptions = {
  /** A full review whatever the record says (`evaluate full`). */
  full?: boolean
}

export function scope(
  root: string,
  config: Record<string, unknown>,
  base: string,
  options: ScopeOptions = {},
): ScopeReport {
  const branch = currentBranch(root)
  const s = settings(config)
  const since = mergeBase(root, base)
  const now = fileChanges(root, since)
  const previous = readRecord(root, branch) ?? null
  const all = Object.keys(now)
  const report = {
    branch,
    head: head(root),
    mergeBase: since,
    settings: s,
    files: all,
    previous,
  }
  const full = (why: string): ScopeReport => ({
    ...report,
    scope: "full",
    review: all,
    dropped: [],
    since: null,
    why,
  })
  if (options.full) {
    return full("a full review was asked for")
  }
  if (s.scope !== "delta") {
    return full("evaluate.scope is full")
  }
  if (!previous) {
    return full(`no evaluation recorded for ${branch}`)
  }
  if (previous.verdict === "stop") {
    // A delta keeps the findings it doesn't re-check, so only a full review
    // can clear a stop.
    return full(
      `the evaluation of ${previous.sha.slice(0, 7)} is stop, which only a full review replaces`,
    )
  }
  const { review, dropped } = moved(now, previous.files)
  if (review.length === 0 && dropped.length === 0) {
    return {
      ...report,
      scope: "carry",
      review: [],
      dropped: [],
      since: previous.sha,
      why:
        previous.sha === report.head
          ? `the evaluation is of HEAD ${previous.sha.slice(0, 7)} already`
          : `no file's change moved since the evaluation of ${previous.sha.slice(0, 7)}`,
    }
  }
  return {
    ...report,
    scope: "delta",
    review,
    dropped,
    since: previous.sha,
    why: `${review.length + dropped.length} file(s) moved since the evaluation of ${previous.sha.slice(0, 7)}`,
  }
}

/** Why the tree can't be recorded, or undefined. */
function dirtyReason(root: string): string | undefined {
  const status = lines(git(root, ["status", "--porcelain"]))
  return status.length > 0
    ? `the working tree has ${status.length} uncommitted or untracked change(s), so the verdict wouldn't be on a commit`
    : undefined
}

function pushedReason(
  root: string,
  remote: string,
  branch: string,
  sha: string,
): string | undefined {
  const out = git(root, ["ls-remote", remote, `refs/heads/${branch}`])
  if (out === undefined) {
    return `can't read ${remote}'s ${branch}`
  }
  const pushed = lines(out)[0]?.split(/\s+/)[0]
  return pushed === sha
    ? undefined
    : `HEAD ${sha.slice(0, 7)} isn't ${remote}'s ${branch} (${pushed ? pushed.slice(0, 7) : "not pushed"}), so the verdict wouldn't be on the pull request's head`
}

export type RecordRequest = {
  base: string
  scope: Scope
  verdict?: Verdict
  summary?: string[]
  remote?: string
  /**
   * The recorded verdict's sha scope saw (`null`: none). When given, a
   * record that changed since (another evaluation recorded meanwhile) refuses.
   */
  previous?: string | null
}

export type RecordResult =
  | {
      recorded: true
      record: EvaluationRecord
      /** A carry onto the commit the record already names: nothing written. */
      unchanged?: true
      /** Previous findings a delta kept, since it didn't re-check their files. */
      kept?: string[]
      /** `evaluate.stopOn: high` made the verdict stop. */
      escalated?: true
    }
  | { recorded: false; reason: string }

const short = (sha: string | null | undefined): string =>
  sha ? sha.slice(0, 7) : "none"

export function record(
  root: string,
  request: RecordRequest,
  config: Record<string, unknown> = {},
): RecordResult {
  const branch = currentBranch(root)
  const sha = head(root)
  const refused =
    dirtyReason(root) ??
    pushedReason(root, request.remote ?? "origin", branch, sha)
  if (refused) {
    return { recorded: false, reason: refused }
  }
  const previous = readRecord(root, branch)
  if (
    request.previous !== undefined &&
    (previous?.sha ?? null) !== request.previous
  ) {
    return {
      recorded: false,
      reason: `the recorded evaluation changed since scope read it (${short(request.previous)} then, ${short(previous?.sha)} now): another evaluation recorded meanwhile`,
    }
  }
  if (request.scope === "carry" && previous?.sha === sha) {
    return { recorded: true, record: previous, unchanged: true }
  }
  const files = fileChanges(root, mergeBase(root, request.base))
  const at = new Date().toISOString()
  let next: EvaluationRecord
  let kept: string[] = []
  let escalated = false
  if (request.scope === "carry") {
    if (!previous) {
      throw new UsageError("--scope carry needs a recorded evaluation")
    }
    next = {
      ...previous,
      sha,
      files,
      scope: "carry",
      carriedFrom: previous.sha,
      recordedAt: at,
    }
  } else {
    if (!request.verdict || !request.summary) {
      throw new UsageError("--verdict and --summary-file are required")
    }
    next = {
      branch,
      sha,
      verdict: request.verdict,
      summary: request.summary,
      files,
      scope: request.scope,
      recordedAt: at,
    }
    if (request.scope === "delta" && previous) {
      const change = moved(files, previous.files)
      const combined = combineDelta(
        previous,
        { verdict: request.verdict, summary: request.summary },
        [...change.review, ...change.dropped],
      )
      next.verdict = combined.verdict
      next.summary = combined.summary
      next.carriedFrom = previous.sha
      kept = combined.kept
    }
    if (
      settings(config).stopOn === "high" &&
      next.verdict !== "stop" &&
      next.summary.slice(1).some(stopsAtHigh)
    ) {
      next.verdict = "stop"
      escalated = true
    }
  }
  writeRecord(root, next)
  return {
    recorded: true,
    record: next,
    ...(kept.length > 0 ? { kept } : {}),
    ...(escalated ? { escalated: true as const } : {}),
  }
}

export type GateResult = {
  /** `off`: merge.requireEvaluation is unset. `ask`: a flag the user must accept. */
  gate: "off" | "pass" | "ask" | "stop"
  reason?: string
  record?: EvaluationRecord
  /** The verdict was carried to HEAD here, since no file's change moved. */
  carried?: boolean
  /**
   * A `stop` a fresh evaluation can settle: no verdict is recorded, or it's
   * on another commit. A `stop` verdict has none: only the work can.
   */
  rerun?: true
}

/**
 * What merge does about the branch's recorded evaluation. A verdict on an
 * older commit carries to HEAD by itself only with `evaluate.scope: delta`,
 * a clean tree, and every file's change as it was (the base merged in, say).
 */
export function gate(
  root: string,
  config: Record<string, unknown>,
  base?: string,
): GateResult {
  const s = settings(config)
  if (!s.requireEvaluation) {
    return { gate: "off" }
  }
  const branch = currentBranch(root)
  const sha = head(root)
  let found = readRecord(root, branch)
  if (!found) {
    return {
      gate: "stop",
      reason: `no evaluation is recorded for ${branch}, and merge.requireEvaluation is ${s.requireEvaluation}`,
      rerun: true,
    }
  }
  let carried = false
  if (found.sha !== sha) {
    const now =
      s.scope === "delta" && base && !dirtyReason(root)
        ? fileChanges(root, mergeBase(root, base))
        : undefined
    const change = now ? moved(now, found.files) : undefined
    if (!now || !change || change.review.length + change.dropped.length > 0) {
      const files = change ? [...change.review, ...change.dropped] : []
      return {
        gate: "stop",
        record: found,
        reason: `the evaluation is of ${found.sha.slice(0, 7)}, but HEAD is ${sha.slice(0, 7)}${files.length > 0 ? `; changed since: ${files.join(", ")}` : ""}`,
        rerun: true,
      }
    }
    found = {
      ...found,
      sha,
      files: now,
      scope: "carry",
      carriedFrom: found.sha,
      recordedAt: new Date().toISOString(),
    }
    writeRecord(root, found)
    carried = true
  }
  const extra = carried ? { carried } : {}
  if (found.verdict === "stop") {
    return {
      gate: "stop",
      record: found,
      reason: "the recorded verdict is stop",
      ...extra,
    }
  }
  if (found.verdict === "flag" && s.requireEvaluation === "pass") {
    return {
      gate: "ask",
      record: found,
      reason:
        "the recorded verdict is flag, and merge.requireEvaluation is pass",
      ...extra,
    }
  }
  return { gate: "pass", record: found, ...extra }
}

/** Seconds `tests` gives the command before it counts as failed. */
export const TESTS_TIMEOUT = 900

/** Lines of the test log's end `tests` prints. */
const TESTS_TAIL = 40

export type TestsRequest = {
  /** The merge base, for `{base}`. */
  base: string
  /** The test files to run, repo-relative. */
  tests: string[]
  timeout?: number
}

export type TestsResult =
  | { ran: false; reason: string }
  | {
      ran: true
      command: string
      passed: boolean
      exitCode: number | null
      timedOut: boolean
      seconds: number
      log: string
      tail: string
    }

/**
 * Run `evaluate.tests` on the tests the agent picked, from the repo root,
 * with its whole output in a log in the worktree's git dir. A failure is a
 * finding for the review, so this reports it and never throws on it.
 */
export function runTests(
  root: string,
  config: Record<string, unknown>,
  request: TestsRequest,
): TestsResult {
  const template = settings(config).tests
  if (!template) {
    return { ran: false, reason: "evaluate.tests is unset" }
  }
  if (request.tests.length === 0) {
    return { ran: false, reason: "no test is relevant to the change" }
  }
  const command = fillCommand(
    template,
    request.base,
    Object.keys(fileChanges(root, request.base)),
  )?.replaceAll("{tests}", request.tests.map(shellQuote).join(" "))
  if (command === undefined) {
    return {
      ran: false,
      reason:
        "evaluate.tests names {files}, and none of the changed files match",
    }
  }
  const dir = stateDir("evaluate", { cwd: root })
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(dir, "tests.log")
  const started = Date.now()
  const result = spawnSync("sh", ["-c", command], {
    cwd: root,
    encoding: "utf8",
    timeout: (request.timeout ?? TESTS_TIMEOUT) * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  fs.writeFileSync(log, `$ ${command}\n${output}`)
  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
  const exitCode = result.error ? null : result.status
  return {
    ran: true,
    command,
    passed: exitCode === 0,
    exitCode,
    timedOut,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    log,
    tail: output.trimEnd().split("\n").slice(-TESTS_TAIL).join("\n"),
  }
}

const USAGE = `Usage: evaluate.ts <subcommand>

  scope --base <ref> [--full]  Which files this evaluation reviews: full, a
                               delta of the files that moved since the
                               recorded verdict, or carry (none moved).
                               --full, or a recorded stop, reviews them all
  record --base <ref> --scope <full|delta|carry> [--verdict <pass|flag|stop>]
         [--summary-file <file>] [--previous <sha|none>] [--remote <name>]
                               Record the verdict on HEAD (refused on a dirty
                               tree, a HEAD that isn't pushed, or a record
                               that isn't the --previous scope saw)
  tests --base <ref> --tests-file <file> [--timeout <seconds>]
                               Run evaluate.tests on the test files listed in
                               <file> (one per line), its output in a log in
                               the git dir, and print whether it passed
  get [--branch <branch>]      The branch's recorded evaluation
  gate [--base <ref>]          What merge.requireEvaluation says about it`

type Args = { flags: Map<string, string> }

function rootOf(): string {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"])?.trim()
  if (!root) {
    throw new UsageError("not inside a git checkout")
  }
  return root
}

function configOf(root: string): Record<string, unknown> {
  const loaded = loadConfig(root)
  return loaded.config ?? {}
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`--${flag} must be one of ${allowed.join(", ")}`)
  }
  return value as T
}

export function main(argv: string[]): void {
  runSubcommand<Args>(
    argv,
    USAGE,
    {
      scope: ({ flags }) => {
        const root = rootOf()
        printJson(
          scope(root, configOf(root), requiredFlag(flags, "base"), {
            full: flags.has("full"),
          }),
        )
      },
      record: ({ flags }) => {
        const root = rootOf()
        const file = flags.get("summary-file")
        const previous = flags.get("previous")
        const result = record(
          root,
          {
            base: requiredFlag(flags, "base"),
            scope: oneOf(
              requiredFlag(flags, "scope"),
              SCOPES,
              "scope",
            ) as Scope,
            verdict: oneOf(flags.get("verdict"), VERDICTS, "verdict"),
            summary: file
              ? lines(fs.readFileSync(file, "utf8")).map((l) => l.trim())
              : undefined,
            remote: flags.get("remote"),
            ...(previous === undefined
              ? {}
              : { previous: previous === "none" ? null : previous }),
          },
          configOf(root),
        )
        printJson(result)
        if (!result.recorded) {
          process.exitCode = 1
        }
      },
      tests: ({ flags }) => {
        const root = rootOf()
        const timeout = flags.get("timeout")
        const seconds = timeout === undefined ? undefined : Number(timeout)
        if (seconds !== undefined && !(seconds > 0)) {
          throw new UsageError("--timeout must be a number of seconds above 0")
        }
        printJson(
          runTests(root, configOf(root), {
            base: requiredFlag(flags, "base"),
            tests: lines(
              fs.readFileSync(requiredFlag(flags, "tests-file"), "utf8"),
            ).map((l) => l.trim()),
            timeout: seconds,
          }),
        )
      },
      get: ({ flags }) => {
        const root = rootOf()
        const branch = flags.get("branch") ?? currentBranch(root)
        const found = readRecord(root, branch) ?? null
        const sha = git(root, ["rev-parse", "HEAD"])?.trim() ?? null
        printJson({
          branch,
          head: sha,
          record: found,
          current: found !== null && found.sha === sha,
        })
      },
      gate: ({ flags }) => {
        const root = rootOf()
        printJson(gate(root, configOf(root), flags.get("base")))
      },
    },
    (rest) => ({ flags: parseFlags(rest, new Set(["full"])) }),
  )
}

if (isMain(import.meta.filename)) {
  runMain(() => main(process.argv.slice(2)))
}

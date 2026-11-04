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
  UsageError,
} from "./lib.ts"
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
  /** One line per finding, the verdict's reason first. */
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
    requireEvaluation:
      at("merge.requireEvaluation") === "pass" ||
      at("merge.requireEvaluation") === "flag"
        ? (at("merge.requireEvaluation") as "pass" | "flag")
        : null,
  }
}

export function recordDir(root: string): string {
  const common = git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])
  if (!common) {
    throw new UsageError("not inside a git repository")
  }
  return path.join(common.trim(), "agent-flows", "evaluate")
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
  why: string
}

export function scope(
  root: string,
  config: Record<string, unknown>,
  base: string,
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
  if (s.scope !== "delta") {
    return {
      ...report,
      scope: "full",
      review: all,
      dropped: [],
      why: "evaluate.scope is full",
    }
  }
  if (!previous) {
    return {
      ...report,
      scope: "full",
      review: all,
      dropped: [],
      why: `no evaluation recorded for ${branch}`,
    }
  }
  const { review, dropped } = moved(now, previous.files)
  if (review.length === 0 && dropped.length === 0) {
    return {
      ...report,
      scope: "carry",
      review: [],
      dropped: [],
      why: `no file's change moved since the evaluation of ${previous.sha.slice(0, 7)}`,
    }
  }
  return {
    ...report,
    scope: "delta",
    review,
    dropped,
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
}

export type RecordResult =
  | { recorded: true; record: EvaluationRecord }
  | { recorded: false; reason: string }

export function record(root: string, request: RecordRequest): RecordResult {
  const branch = currentBranch(root)
  const sha = head(root)
  const refused =
    dirtyReason(root) ??
    pushedReason(root, request.remote ?? "origin", branch, sha)
  if (refused) {
    return { recorded: false, reason: refused }
  }
  const previous = readRecord(root, branch)
  const files = fileChanges(root, mergeBase(root, request.base))
  const at = new Date().toISOString()
  let next: EvaluationRecord
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
      next.verdict = worse(request.verdict, previous.verdict)
      next.summary = [
        ...request.summary,
        ...previous.summary.filter((line) => !request.summary?.includes(line)),
      ]
      next.carriedFrom = previous.sha
    }
  }
  writeRecord(root, next)
  return { recorded: true, record: next }
}

export type GateResult = {
  /** `off`: merge.requireEvaluation is unset. `ask`: a flag the user must accept. */
  gate: "off" | "pass" | "ask" | "stop"
  reason?: string
  record?: EvaluationRecord
  /** The verdict was carried to HEAD here, since no file's change moved. */
  carried?: boolean
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

const USAGE = `Usage: evaluate.ts <subcommand>

  scope --base <ref>           Which files this evaluation reviews: full, a
                               delta of the files that moved since the
                               recorded verdict, or carry (none moved)
  record --base <ref> --scope <full|delta|carry> [--verdict <pass|flag|stop>]
         [--summary-file <file>] [--remote <name>]
                               Record the verdict on HEAD (refused on a dirty
                               tree, or a HEAD that isn't pushed)
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
        printJson(scope(root, configOf(root), requiredFlag(flags, "base")))
      },
      record: ({ flags }) => {
        const root = rootOf()
        const file = flags.get("summary-file")
        const result = record(root, {
          base: requiredFlag(flags, "base"),
          scope: oneOf(requiredFlag(flags, "scope"), SCOPES, "scope") as Scope,
          verdict: oneOf(flags.get("verdict"), VERDICTS, "verdict"),
          summary: file
            ? lines(fs.readFileSync(file, "utf8")).map((l) => l.trim())
            : undefined,
          remote: flags.get("remote"),
        })
        printJson(result)
        if (!result.recorded) {
          process.exitCode = 1
        }
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
    (rest) => ({ flags: parseFlags(rest) }),
  )
}

if (isMain(import.meta.filename)) {
  runMain(() => main(process.argv.slice(2)))
}

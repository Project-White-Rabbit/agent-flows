// The mechanical half of the sync flow: git state, the no-op gate, and the
// per-branch state that lets a re-run skip what hasn't changed. Everything
// vendor-specific (pull requests, issues, stacks) stays in the skill, which
// reaches it through the configured integrations' ops and passes the results
// in here as arguments.
//
// State lives in the worktree's private git dir, so it never dirties the tree
// (a dirty tree would defeat the gate it feeds) and can't be committed.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isMain, printJson, run, runMain } from "./lib.ts"

export const MODES = ["default", "local", "remote"] as const
export type Mode = (typeof MODES)[number]

/** Wraps the part of a pull request body that sync owns. */
export const BLOCK_START = "<!-- agent-flows:sync -->"
export const BLOCK_END = "<!-- /agent-flows:sync -->"

/** A pull request as the flow sees it: `none`, or `<number>:<state>:<draft>`. */
export type PrState = {
  number: string
  state: "open" | "merged" | "closed"
  draft: boolean
}

export type BranchState = {
  issue?: string
  errorRefs?: string[]
  /** Whether a legacy state file was already read for this branch. */
  legacyRead?: boolean
  /** The last sync of any mode. */
  last?: { head: string; tree: string; baseHead: string; pr: string }
  /** The last sync that wrote the pull request and issue. */
  remote?: { head: string; pr: string; linkedRefs: string[] }
}

export type SyncState = { branches: Record<string, BranchState> }

export type WorkState =
  | "todo"
  | "in progress"
  | "in review"
  | "done"
  | "canceled"

export function parsePr(text: string | undefined): PrState | undefined {
  if (!text || text === "none") {
    return undefined
  }
  const match = text.match(/^(\d+):(open|merged|closed):(true|false)$/i)
  if (!match) {
    throw new Error(
      `--pr must be \`none\` or \`<number>:<open|merged|closed>:<true|false>\`, got \`${text}\``,
    )
  }
  return {
    number: match[1],
    state: match[2].toLowerCase() as PrState["state"],
    draft: match[3].toLowerCase() === "true",
  }
}

export function prKey(pr: PrState | undefined): string {
  return pr ? `${pr.number}:${pr.state}:${pr.draft}` : "none"
}

export type Gate = {
  runLocal: boolean
  runRemote: boolean
  noop: boolean
  newErrorRefs: string[]
}

/**
 * Which phases this run needs. Local work runs when there's something to
 * commit, catch up, or (in default mode) push; remote writes run when the pull
 * request or issue doesn't yet reflect this HEAD, the pull request changed
 * state, or an error ref hasn't been linked.
 */
export function gate(input: {
  mode: Mode
  onBase: boolean
  dirty: boolean
  ahead: number
  behind: number
  /** Commits not on the remote branch; undefined when it was never pushed. */
  unpushed: number | undefined
  head: string
  pr: PrState | undefined
  stored: BranchState | undefined
}): Gate {
  const { mode, stored } = input
  const linked = new Set(stored?.remote?.linkedRefs ?? [])
  const newErrorRefs = (stored?.errorRefs ?? []).filter((r) => !linked.has(r))
  const needsPush =
    mode === "default" &&
    input.ahead > 0 &&
    (input.unpushed === undefined || input.unpushed > 0)
  const runLocal =
    mode !== "remote" &&
    (input.onBase || input.dirty || input.behind > 0 || needsPush)
  // Local work in default mode moves HEAD, so the remote writes follow it.
  const runRemote =
    mode !== "local" &&
    ((mode === "default" && runLocal) ||
      input.pr === undefined ||
      stored?.remote?.head !== input.head ||
      stored?.remote?.pr !== prKey(input.pr) ||
      newErrorRefs.length > 0)
  return { runLocal, runRemote, noop: !runLocal && !runRemote, newErrorRefs }
}

/** The issue state the pull request and branch imply. */
export function workState(pr: PrState | undefined, ahead: number): WorkState {
  if (pr?.state === "merged") {
    return "done"
  }
  if (pr?.state === "closed") {
    return "canceled"
  }
  if (ahead === 0) {
    return "todo"
  }
  return pr?.state === "open" && !pr.draft ? "in review" : "in progress"
}

const LAST_SYNCED = /^_Last synced: .*_$/

/** Sections an earlier sync tool regenerated, which the block now holds. */
const LEGACY_SECTIONS = new Set(["Summary", "Test plan"])

/**
 * A body without what an earlier sync tool (bitfab-dev's, which this one
 * replaces) wrote there without markers: the `> Name:` link lines on top, its
 * Summary and Test plan sections, and its last-synced line. Only a body with
 * that last-synced line is touched, so a person's own Summary survives.
 */
export function withoutLegacySync(body: string): string {
  const lines = body.split("\n")
  if (!lines.some((line) => LAST_SYNCED.test(line.trim()))) {
    return body
  }
  const kept: string[] = []
  let top = true
  let skipping = false
  for (const line of lines) {
    const text = line.trim()
    if (top && (text === "" || /^> [A-Z][\w ]*:/.test(text))) {
      continue
    }
    top = false
    const heading = text.match(/^## (.+)$/)
    if (heading) {
      skipping = LEGACY_SECTIONS.has(heading[1].trim())
    }
    if (LAST_SYNCED.test(text)) {
      // It ended the generated part; anything after it is a person's.
      skipping = false
      continue
    }
    if (!skipping && !text.startsWith("<!-- bitfab-sync:")) {
      kept.push(line)
    }
  }
  return kept.join("\n")
}

/**
 * The pull request body with sync's block replaced, or put on top when the
 * body has none yet, in place of what an earlier sync tool generated there.
 * Everything else is someone else's and stays.
 */
export function spliceBlock(body: string, block: string): string {
  const inner = block.replace(BLOCK_START, "").replace(BLOCK_END, "").trim()
  const wrapped = `${BLOCK_START}\n${inner}\n${BLOCK_END}`
  const start = body.indexOf(BLOCK_START)
  const end = body.indexOf(BLOCK_END, start)
  if (start !== -1 && end !== -1) {
    return body.slice(0, start) + wrapped + body.slice(end + BLOCK_END.length)
  }
  const rest = withoutLegacySync(body).trim()
  return rest ? `${wrapped}\n\n${rest}\n` : `${wrapped}\n`
}

export function lastSyncedLine(head: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ")
  return `_Last synced: ${stamp} UTC (HEAD: ${head.slice(0, 7)})_`
}

// --- git ---------------------------------------------------------------------

function git(args: string[]): string | undefined {
  const result = run("git", args)
  return result.status === 0 ? result.stdout.trim() : undefined
}

function count(range: string): number {
  return Number(git(["rev-list", "--count", range]) ?? 0)
}

function refExists(ref: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", ref]) !== undefined
}

/** `origin/<base>` when it exists, so a stale local base doesn't skew counts. */
function baseRefOf(base: string): string | undefined {
  if (refExists(`refs/remotes/origin/${base}`)) {
    return `origin/${base}`
  }
  return refExists(`refs/heads/${base}`) ? base : undefined
}

function treeHash(): string {
  const status = git(["status", "--porcelain"]) ?? ""
  return createHash("sha256").update(status).digest("hex")
}

function statePath(): string {
  const gitDir = git(["rev-parse", "--absolute-git-dir"])
  if (!gitDir) {
    throw new Error("not inside a git repository")
  }
  return path.join(gitDir, "agent-flows", "sync.json")
}

/**
 * Where an earlier sync tool (bitfab-dev's) kept a branch's issue and error
 * refs, relative to the worktree root, newest first.
 */
export const LEGACY_STATE_FILES = [
  ".bitfab-dev/state.json",
  ".bitfab-sync/state.json",
]

/**
 * The issue and error refs a legacy state file holds for `branch`. It keeps
 * one branch, so a file written on another branch says nothing about this one.
 */
export function readLegacyState(
  root: string,
  branch: string,
): { issue?: string; errorRefs: string[] } | undefined {
  for (const file of LEGACY_STATE_FILES) {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"))
    } catch {
      continue
    }
    const state = parsed as {
      branch?: unknown
      linearId?: unknown
      sentryRefs?: unknown
    }
    if (typeof state !== "object" || state === null) {
      continue
    }
    if (state.branch !== branch) {
      return undefined
    }
    const refs = Array.isArray(state.sentryRefs) ? state.sentryRefs : []
    return {
      ...(typeof state.linearId === "string" && state.linearId
        ? { issue: state.linearId }
        : {}),
      errorRefs: refs
        .map((ref: { id?: unknown; url?: unknown }) =>
          typeof ref?.id === "string" && ref.id
            ? ref.id
            : typeof ref?.url === "string"
              ? ref.url
              : undefined,
        )
        .filter((ref): ref is string => Boolean(ref)),
    }
  }
  return undefined
}

export function readState(file: string): SyncState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SyncState
    if (parsed && typeof parsed.branches === "object") {
      return parsed
    }
  } catch {
    // Missing or unreadable: start over, which only costs one full sync.
  }
  return { branches: {} }
}

function writeState(file: string, state: SyncState): void {
  // Forget branches that no longer exist, so the file doesn't grow forever.
  for (const branch of Object.keys(state.branches)) {
    if (!refExists(`refs/heads/${branch}`)) {
      delete state.branches[branch]
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
}

// --- arguments ---------------------------------------------------------------

type Args = { positional: string[]; flags: Map<string, string[]> }

/** Flags that take no value; every other flag takes the next argument. */
const SWITCHES = new Set(["remote"])

function parseArgs(args: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    let value = ""
    if (!SWITCHES.has(name)) {
      value = args[++i]
      if (value === undefined) {
        throw new Error(`--${name} needs a value`)
      }
    }
    flags.set(name, [...(flags.get(name) ?? []), value])
  }
  return { positional, flags }
}

function flag(args: Args, name: string): string | undefined {
  return args.flags.get(name)?.at(-1)
}

function required(args: Args, name: string): string {
  const value = flag(args, name)
  if (!value) {
    throw new Error(`--${name} <value> is required`)
  }
  return value
}

function currentBranch(): string {
  const branch = git(["branch", "--show-current"])
  if (!branch) {
    throw new Error(
      "HEAD is detached. Check out a branch, then re-run: sync records its state per branch.",
    )
  }
  return branch
}

// --- subcommands -------------------------------------------------------------

function survey(args: Args): void {
  const mode = (args.positional[0] ?? "default") as Mode
  if (!MODES.includes(mode)) {
    throw new Error(`mode must be one of ${MODES.join(", ")}, got \`${mode}\``)
  }
  const base = required(args, "base")
  const pr = parsePr(required(args, "pr"))
  const branch = currentBranch()
  // Remote mode never catches up, so it doesn't need a fresh base.
  if (mode !== "remote") {
    run("git", ["fetch", "--quiet", "origin", base])
  }
  const baseRef = baseRefOf(base)
  const head = git(["rev-parse", "HEAD"]) ?? "none"
  const dirty = (git(["status", "--porcelain"]) ?? "") !== ""
  const ahead = baseRef ? count(`${baseRef}..HEAD`) : 0
  const behind = baseRef ? count(`HEAD..${baseRef}`) : 0
  const upstream = `refs/remotes/origin/${branch}`
  const unpushed = refExists(upstream)
    ? count(`origin/${branch}..HEAD`)
    : undefined

  const file = statePath()
  const state = readState(file)
  let stored = state.branches[branch]
  let changed = false
  // A branch an earlier sync tool synced keeps its issue and error refs. Read
  // once, so an issue a later sync drops doesn't come back.
  if (!stored?.legacyRead) {
    const root = git(["rev-parse", "--show-toplevel"])
    const legacy = root ? readLegacyState(root, branch) : undefined
    stored = {
      ...stored,
      ...(legacy?.issue && !stored?.issue ? { issue: legacy.issue } : {}),
      errorRefs: [
        ...new Set([
          ...(stored?.errorRefs ?? []),
          ...(legacy?.errorRefs ?? []),
        ]),
      ],
      legacyRead: true,
    }
    changed = legacy !== undefined
  }
  const passedRefs = args.flags.get("error-ref") ?? []
  if (passedRefs.length > 0 && mode !== "local") {
    stored = {
      ...stored,
      errorRefs: [...new Set([...(stored?.errorRefs ?? []), ...passedRefs])],
    }
    changed = true
  }
  if (changed) {
    state.branches[branch] = stored
    writeState(file, state)
  }
  const current = stored
  const onBase = branch === base
  const signals = gate({
    mode,
    onBase,
    dirty,
    ahead,
    behind,
    unpushed,
    head,
    pr,
    stored: current,
  })
  printJson({
    mode,
    branch,
    base,
    baseRef: baseRef ?? null,
    onBase,
    dirty,
    ahead,
    behind,
    unpushed: unpushed ?? null,
    head,
    pr: prKey(pr),
    issue: current?.issue ?? null,
    errorRefs: current?.errorRefs ?? [],
    newErrorRefs: signals.newErrorRefs,
    lastSyncedHead: current?.remote?.head ?? null,
    runLocal: signals.runLocal,
    runRemote: signals.runRemote,
    noop: signals.noop,
  })
}

function facts(args: Args): void {
  const base = required(args, "base")
  const pr = parsePr(required(args, "pr"))
  const branch = currentBranch()
  run("git", ["fetch", "--quiet", "origin", base])
  const baseRef = baseRefOf(base)
  const head = git(["rev-parse", "HEAD"]) ?? "none"
  const ahead = baseRef ? count(`${baseRef}..HEAD`) : 0
  const stored = readState(statePath()).branches[branch]
  const full = stored?.remote?.head !== head
  printJson({
    workState: workState(pr, ahead),
    lastSyncedLine: lastSyncedLine(head),
    // Only the pull request's state moved: refresh state and links, not prose.
    updateKind: full ? "full" : "metadata-only",
    ...(full && baseRef
      ? {
          commits: git(["log", "--oneline", `${baseRef}..HEAD`]) ?? "",
          diffStat: git(["diff", "--stat", `${baseRef}...HEAD`]) ?? "",
        }
      : {}),
  })
}

function splice(args: Args): void {
  const bodyFile = required(args, "body")
  const block = fs.readFileSync(required(args, "block"), "utf8")
  let body = ""
  try {
    body = fs.readFileSync(bodyFile, "utf8")
  } catch {
    // No body yet.
  }
  process.stdout.write(spliceBlock(body, block))
}

function finish(args: Args): void {
  const base = required(args, "base")
  const pr = parsePr(required(args, "pr"))
  const branch = currentBranch()
  const baseRef = baseRefOf(base)
  const head = git(["rev-parse", "HEAD"]) ?? "none"
  const file = statePath()
  const state = readState(file)
  const entry: BranchState = { ...state.branches[branch] }
  entry.last = {
    head,
    tree: treeHash(),
    baseHead: (baseRef && git(["rev-parse", baseRef])) || "none",
    pr: prKey(pr),
  }
  const issue = flag(args, "issue")
  if (issue === "none") {
    delete entry.issue
  } else if (issue) {
    entry.issue = issue
  }
  if (args.flags.has("remote")) {
    const linked = args.flags.get("linked-ref") ?? []
    entry.remote = {
      head,
      pr: prKey(pr),
      linkedRefs: [
        ...new Set([...(entry.remote?.linkedRefs ?? []), ...linked]),
      ],
    }
  }
  state.branches[branch] = entry
  writeState(file, state)
  printJson({ written: true, branch, head })
}

const USAGE = `Usage: sync.ts <command>

  survey <default|local|remote> --base <branch> --pr <pr> [--error-ref <ref>]...
                  Fetch the base (not in remote mode), read git state, and
                  print it with the gate: runLocal, runRemote, noop. Error refs
                  are remembered for the branch until a remote sync links them.
  facts --base <branch> --pr <pr>
                  For the remote writes: the issue's workState, the
                  lastSyncedLine, updateKind (full or metadata-only), and, for
                  a full update, commits and diffStat against the base.
  splice --body <file> --block <file>
                  Print the pull request body with sync's block replaced (or
                  added on top, in place of the sections an earlier sync tool
                  wrote), leaving the rest of the body alone.
  finish --base <branch> --pr <pr> [--remote] [--issue <id|none>] [--linked-ref <ref>]...
                  Record this sync so the next one can skip what's unchanged.
                  --remote when the pull request and issue were written (or
                  already current). --issue none forgets the cached issue.

<pr> is \`none\` or \`<number>:<open|merged|closed>:<true|false>\` (draft).
State is kept per branch in the worktree's git dir. A branch with no state yet
starts from the issue and error refs bitfab-dev's sync left in
.bitfab-dev/state.json, when they're for that branch.`

const SUBCOMMANDS: Record<string, (args: Args) => void> = {
  survey,
  facts,
  splice,
  finish,
}

export function main(argv: string[]): void {
  const [command, ...rest] = argv
  const subcommand = command ? SUBCOMMANDS[command] : undefined
  if (!subcommand) {
    console.log(USAGE)
    process.exitCode = command && command !== "help" ? 1 : 0
    return
  }
  subcommand(parseArgs(rest))
}

if (isMain(import.meta.filename)) {
  runMain(() => main(process.argv.slice(2)))
}

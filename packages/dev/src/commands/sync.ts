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

/**
 * The pull request body with sync's block replaced, or put on top when the
 * body has none yet. Everything outside the block is someone else's and stays.
 */
export function spliceBlock(body: string, block: string): string {
  const inner = block.replace(BLOCK_START, "").replace(BLOCK_END, "").trim()
  const wrapped = `${BLOCK_START}\n${inner}\n${BLOCK_END}`
  const start = body.indexOf(BLOCK_START)
  const end = body.indexOf(BLOCK_END, start)
  if (start !== -1 && end !== -1) {
    return body.slice(0, start) + wrapped + body.slice(end + BLOCK_END.length)
  }
  const rest = body.trim()
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
  const stored = state.branches[branch]
  const passedRefs = args.flags.get("error-ref") ?? []
  if (passedRefs.length > 0 && mode !== "local") {
    const errorRefs = [
      ...new Set([...(stored?.errorRefs ?? []), ...passedRefs]),
    ]
    state.branches[branch] = { ...stored, errorRefs }
    writeState(file, state)
  }
  const current = state.branches[branch]
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
  if (issue) {
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
                  added on top), leaving the rest of the body alone.
  finish --base <branch> --pr <pr> [--remote] [--issue <id>] [--linked-ref <ref>]...
                  Record this sync so the next one can skip what's unchanged.
                  --remote when the pull request and issue were written (or
                  already current).

<pr> is \`none\` or \`<number>:<open|merged|closed>:<true|false>\` (draft).
State is kept per branch in the worktree's git dir.`

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

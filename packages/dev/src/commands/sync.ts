// The mechanical half of the sync flow: git state, the no-op gate, and the
// per-branch state that lets a re-run skip what hasn't changed. Everything
// vendor-specific (pull requests, issues, stacks) stays in the skill, which
// reaches it through the configured integrations' ops and passes the results
// in here as arguments.
//
// State lives in the repo's git common dir, one file per branch, so it never
// dirties the tree (a dirty tree would defeat the gate it feeds), can't be
// committed, and follows a branch to whichever worktree checks it out. A
// branch is checked out in one worktree at a time, so each file has one writer.

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { getAt, INSTANCE_KEY, instancesOf } from "../config/config.ts"
import { integrationId } from "../config/integrations.ts"
import { plainDocumentLinks } from "../config/links.ts"
import { type Routed, routeProject, routesOf } from "../config/projects.ts"
import { INTEGRATIONS } from "../config/sections/index.ts"
import { BITFAB_DEV_FORMAT } from "../config/sections/sync.ts"
import { usesOf } from "../config/use.ts"
import { loadConfig } from "./configure.ts"
import { isMain, printJson, run, runMain, runSubcommand } from "./lib.ts"

export const MODES = ["default", "local", "remote"] as const
export type Mode = (typeof MODES)[number]

/** Wraps the part of a pull request body that sync owns. */
export const BLOCK_START = "<!-- agent-flows:sync -->"
export const BLOCK_END = "<!-- /agent-flows:sync -->"

/**
 * How sync writes its link lines, the PR title, and its part of the PR body:
 * the config's `sync` section, then the format the branch was last written in,
 * then sync's own.
 */
export type SyncFormat = {
  /** `> Issue:` and `> Errors:`, or each line named for its integration. */
  linkLabels: "capability" | "integration"
  /** A word that starts each error line, like bitfab-dev's `Fixes`. */
  errorVerb: string | null
  /** A title template with `{issueId}`, `{title}`, and `{summary}`; null follows the repo. */
  prTitle: string | null
  blockMarkers: boolean
  /** The PR body's link lines as quotes (`> Issue:`), or plain (`Issue:`). */
  quoteLinks: boolean
  /** The headings of sync's PR body sections; null follows the template, else Summary and Test plan. */
  prSections: string[] | null
  /** Whether the body carries the tracker's \`prLink\` line (\`Fixes <ID>\`). */
  prLinkLine: boolean
  /** With no issue, the issue line still goes in, with this after its label (\`none\`); null leaves it out. */
  noIssueLine: string | null
  /** The last-synced line ending the block; always with \`blockMarkers\` false, where it's the boundary. */
  footer: boolean
  /** A regex source for another tool's link lines on top of a body it wrote, so sync replaces that body. */
  adoptHeader: string | null
}

export function syncFormat(
  config: Record<string, unknown> | undefined,
  recorded?: Partial<SyncFormat>,
): SyncFormat {
  const section = config?.sync
  const values: Partial<Record<keyof SyncFormat, unknown>> = {
    ...recorded,
    ...(section && typeof section === "object" ? section : {}),
  }
  return {
    linkLabels:
      values.linkLabels === "integration" ? "integration" : "capability",
    errorVerb: typeof values.errorVerb === "string" ? values.errorVerb : null,
    prTitle: typeof values.prTitle === "string" ? values.prTitle : null,
    blockMarkers: values.blockMarkers !== false,
    quoteLinks: values.quoteLinks !== false,
    prSections:
      Array.isArray(values.prSections) &&
      values.prSections.length > 0 &&
      values.prSections.every((heading) => typeof heading === "string")
        ? values.prSections
        : null,
    prLinkLine: values.prLinkLine !== false,
    noIssueLine:
      typeof values.noIssueLine === "string" && values.noIssueLine.trim()
        ? values.noIssueLine
        : null,
    // Without markers, the last-synced line is where sync's part ends.
    footer: values.footer !== false || values.blockMarkers === false,
    adoptHeader:
      typeof values.adoptHeader === "string" && compiles(values.adoptHeader)
        ? values.adoptHeader
        : null,
  }
}

/** Whether `source` is a regex this runtime accepts. */
export function compiles(source: string): boolean {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
}

/** A pull request as the flow sees it: `none`, or `<number>:<state>:<draft>`. */
export type PrState = {
  number: string
  state: "open" | "merged" | "closed"
  draft: boolean
}

export type BranchState = {
  issue?: string
  errorRefs?: string[]
  /** The format the last remote sync wrote, so the next one keeps it. */
  format?: SyncFormat
  /** Whether a legacy state file was already read for this branch. */
  legacyRead?: boolean
  /** The last sync of any mode. */
  last?: { head: string; tree: string; baseHead: string; pr: string }
  /** The last sync that wrote the pull request and issue. */
  remote?: { head: string; pr: string; linkedRefs: string[] }
}

/** The single per-worktree file state used to live in, before 0.5. */
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
 * The last-synced line, as sync writes it (`_…_`) or as Linear stores it
 * (`*…*`), so a description read back from Linear still has its marker found.
 */
export const LAST_SYNCED = /^([_*])Last synced: .*\1$/

/** Sections an earlier sync tool regenerated, which the block now holds. */
const LEGACY_SECTIONS = new Set(["Summary", "Test plan"])

/**
 * A body without what an earlier sync tool (bitfab-dev's, which this one
 * replaces) wrote there without markers: the `> Name:` link lines on top, its
 * Summary and Test plan sections, and its last-synced line. Only a body with
 * that last-synced line is touched, so a person's own Summary survives.
 *
 * With `ownSections`, the body is one sync wrote without markers itself: those
 * sections are its too, and so is everything above the first heading.
 */
export function withoutLegacySync(
  body: string,
  ownSections?: string[],
  adopt?: Adopt,
): string {
  const lines = body.split("\n")
  if (!lines.some((line) => LAST_SYNCED.test(line.trim()))) {
    return adopt ? withoutAdopted(body, adopt) : body
  }
  const generated = new Set([...LEGACY_SECTIONS, ...(ownSections ?? [])])
  const kept: string[] = []
  let top = true
  let skipping = false
  for (const line of lines) {
    const text = line.trim()
    const preamble =
      ownSections !== undefined &&
      !text.startsWith("## ") &&
      !LAST_SYNCED.test(text)
    if (top && (text === "" || /^> [A-Z][\w ]*:/.test(text) || preamble)) {
      continue
    }
    top = false
    const heading = text.match(/^## (.+)$/)
    if (heading) {
      skipping = generated.has(heading[1].trim())
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
 * Another sync tool a repo adopts: `header` matches the link lines it puts on
 * top of a body it wrote, and `sections` are the headings sync now writes.
 */
export type Adopt = { header: RegExp; sections: string[] }

/**
 * A body without what another tool wrote there, when its first line is that
 * tool's header: the header lines (and blank lines among them) on top, and the
 * sections sync now writes, each up to the next heading. Any other body, and
 * every other section, is a person's and stays as it is.
 */
export function withoutAdopted(body: string, adopt: Adopt): string {
  const lines = body.split("\n")
  const first = lines.findIndex((line) => line.trim() !== "")
  if (first === -1 || !adopt.header.test(lines[first].trim())) {
    return body
  }
  const generated = new Set(adopt.sections)
  const kept: string[] = []
  let top = true
  let skipping = false
  for (const line of lines) {
    const text = line.trim()
    if (top && (text === "" || adopt.header.test(text))) {
      continue
    }
    top = false
    const heading = text.match(/^## (.+)$/)
    if (heading) {
      skipping = generated.has(heading[1].trim())
    }
    if (!skipping) {
      kept.push(line)
    }
  }
  return kept.join("\n")
}

/**
 * The pull request body with sync's block replaced, or put on top when the
 * body has none yet, in place of what an earlier sync tool generated there.
 * Everything else is someone else's and stays.
 *
 * Without markers, the block goes on top unwrapped, as bitfab-dev's sync
 * writes it, and the old one is found the way that tool's is: the link lines
 * on top through the last-synced line. A block written with markers before is
 * replaced too.
 */
export function spliceBlock(
  body: string,
  block: string,
  {
    markers = true,
    adoptHeader,
  }: { markers?: boolean; adoptHeader?: string | null } = {},
): string {
  const inner = block.replace(BLOCK_START, "").replace(BLOCK_END, "").trim()
  const wrapped = `${BLOCK_START}\n${inner}\n${BLOCK_END}`
  const start = body.indexOf(BLOCK_START)
  const end = body.indexOf(BLOCK_END, start)
  const sections = [...inner.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
  const adopt =
    adoptHeader && compiles(adoptHeader)
      ? { header: new RegExp(adoptHeader), sections }
      : undefined
  if (!markers) {
    const unmarked =
      start !== -1 && end !== -1
        ? body.slice(0, start) + body.slice(end + BLOCK_END.length)
        : body
    const rest = withoutLegacySync(unmarked, sections, adopt).trim()
    return rest ? `${inner}\n\n${rest}\n` : `${inner}\n`
  }
  if (start !== -1 && end !== -1) {
    return body.slice(0, start) + wrapped + body.slice(end + BLOCK_END.length)
  }
  const rest = withoutLegacySync(body, undefined, adopt).trim()
  return rest ? `${wrapped}\n\n${rest}\n` : `${wrapped}\n`
}

/**
 * An issue description ready to write back: its document links plain (see
 * plainDocumentLinks), and, when it has `current` (this sync's last-synced
 * line), without any other last-synced line, so an older marker (Linear's
 * `*…*` included) isn't left beside the new one.
 */
export function issueDescription(text: string, current?: string): string {
  const plain = plainDocumentLinks(text)
  const lines = plain.split("\n")
  if (!current || !lines.some((line) => line.trim() === current)) {
    return plain
  }
  let kept = false
  return lines
    .filter((line) => {
      const trimmed = line.trim()
      if (trimmed === current && !kept) {
        kept = true
        return true
      }
      return !LAST_SYNCED.test(trimmed)
    })
    .join("\n")
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

/**
 * `origin/<base>`, once a fetch has had the chance to bring it. Without it,
 * every count against the base is a guess, and a branch would read as synced:
 * stop instead.
 */
function fetchedBaseRef(base: string): string {
  if (!refExists(`refs/remotes/origin/${base}`)) {
    throw new Error(
      `origin/${base} doesn't exist after fetching it. Check that origin has a branch named ${base} (repo.baseBranch) and that this checkout can reach origin, then re-run.`,
    )
  }
  return `origin/${base}`
}

/**
 * Whether origin still has `branch`, by asking it: the remote-tracking ref
 * outlives a branch deleted on the host, and would make commits read as pushed.
 * Undefined when origin can't be asked, so the caller keeps the local ref.
 */
function remoteHasBranch(branch: string): boolean | undefined {
  const result = run("git", ["ls-remote", "--heads", "origin", branch])
  if (result.status !== 0) {
    return undefined
  }
  return result.stdout
    .split("\n")
    .some((line) => line.trim().endsWith(`refs/heads/${branch}`))
}

function treeHash(): string {
  const status = git(["status", "--porcelain"]) ?? ""
  return createHash("sha256").update(status).digest("hex")
}

/** `routedProjects` for this checkout, reading the changed files only when needed. */
function surveyProjects(
  baseRef: string | undefined,
): Record<string, Routed | null> {
  const root = git(["rev-parse", "--show-toplevel"])
  let changed: string[] | undefined
  return routedProjects(root ? loadConfig(root).config : undefined, () => {
    changed ??= changedFiles(baseRef)
    return changed
  })
}

/** The branch's sync format, with the config's sync section over `recorded`. */
function readFormat(recorded: SyncFormat | undefined): SyncFormat {
  const root = git(["rev-parse", "--show-toplevel"])
  return syncFormat(root ? loadConfig(root).config : undefined, recorded)
}

/** What the pull request will hold: changed since the merge base, uncommitted, and untracked. */
function changedFiles(baseRef: string | undefined): string[] {
  const lines = (text: string | undefined) =>
    (text ?? "").split("\n").filter((line) => line !== "")
  return [
    ...new Set([
      ...(baseRef
        ? lines(git(["diff", "--name-only", `${baseRef}...HEAD`]))
        : []),
      ...lines(git(["diff", "--name-only", "HEAD"])),
      ...lines(git(["ls-files", "--others", "--exclude-standard"])),
    ]),
  ].sort()
}

/**
 * For each issue-tracker entry whose `projects` claim paths (by its instance
 * name, else its integration), the project the branch's changes put its
 * issue in: null when none match, so the entry's default applies.
 */
export function routedProjects(
  config: Record<string, unknown> | undefined,
  changed: () => string[],
): Record<string, Routed | null> {
  const out: Record<string, Routed | null> = {}
  for (const spec of INTEGRATIONS) {
    if (!("issueTracker" in spec.provides) || !config) {
      continue
    }
    for (const values of instancesOf(getAt(config, spec.path))) {
      if (
        routesOf(values.projects).length === 0 ||
        !usesOf(spec, values).issueTracker
      ) {
        continue
      }
      const instance = values[INSTANCE_KEY]
      const key = typeof instance === "string" ? instance : integrationId(spec)
      out[key] = routeProject(values.projects, changed()) ?? null
    }
  }
  return out
}

function gitPath(flag: string): string {
  const dir = git(["rev-parse", "--path-format=absolute", flag])
  if (!dir) {
    throw new Error("not inside a git repository")
  }
  return dir
}

/** Where each branch's state lives, shared by the repo's worktrees. */
function stateDir(): string {
  const dir = path.join(gitPath("--git-common-dir"), "agent-flows", "sync")
  migrateState(
    path.join(gitPath("--absolute-git-dir"), "agent-flows", "sync.json"),
    dir,
  )
  return dir
}

export function branchFile(dir: string, branch: string): string {
  return path.join(dir, `${encodeURIComponent(branch)}.json`)
}

export function readBranchState<T extends object = BranchState>(
  dir: string,
  branch: string,
): T | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(branchFile(dir, branch), "utf8"))
    if (parsed && typeof parsed === "object") {
      return parsed as T
    }
  } catch {
    // Missing or unreadable: start over, which only costs one full sync.
  }
  return undefined
}

/**
 * Write one branch's state, through a temp file so a crash never leaves half
 * of one, and forget branches that no longer exist, so the dir doesn't grow
 * forever.
 */
export function writeBranchState<T extends object = BranchState>(
  dir: string,
  branch: string,
  state: T,
  exists: (branch: string) => boolean = (b) => refExists(`refs/heads/${b}`),
): void {
  fs.mkdirSync(dir, { recursive: true })
  const file = branchFile(dir, branch)
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(temp, file)
  for (const name of fs.readdirSync(dir)) {
    if (
      name.endsWith(".json") &&
      !exists(decodeURIComponent(name.slice(0, -5)))
    ) {
      fs.rmSync(path.join(dir, name), { force: true })
    }
  }
}

/**
 * Move a worktree's pre-0.5 state file into the shared dir, keeping a branch's
 * newer state there when both have it, then remove the old file.
 */
export function migrateState(oldFile: string, dir: string): void {
  if (!fs.existsSync(oldFile)) {
    return
  }
  for (const [branch, state] of Object.entries(readState(oldFile).branches)) {
    if (!fs.existsSync(branchFile(dir, branch))) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        branchFile(dir, branch),
        `${JSON.stringify(state, null, 2)}\n`,
      )
    }
  }
  fs.rmSync(oldFile, { force: true })
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
  adopt: AdoptFiles = { files: [] },
): LegacyState | undefined {
  // bitfab-dev's files, newest first: the first one there decides.
  for (const file of LEGACY_STATE_FILES) {
    const state = readStateFile(path.join(root, file))
    if (state) {
      if (state.branch === branch) {
        return fromLegacy(state)
      }
      break
    }
  }
  // Each adopted tool's file on its own, since each writes only its own.
  for (const file of adopt.files) {
    const resolved = resolveAdopted(root, file, adopt)
    const state = resolved ? readStateFile(resolved) : undefined
    if (state?.branch === branch) {
      return { ...fromLegacy(state), adopted: true }
    }
  }
  return undefined
}

/** What an earlier sync tool left for a branch. `adopted`: from `sync.adoptState`. */
export type LegacyState = {
  issue?: string
  errorRefs: string[]
  adopted?: boolean
}

/** `sync.adoptState`'s paths, and the dirs their placeholders stand for. */
export type AdoptFiles = {
  files: string[]
  gitDir?: string
  gitCommonDir?: string
}

/**
 * An adopted path: `{gitDir}` and `{gitCommonDir}` filled in, anything else
 * relative to the worktree root. Undefined when a placeholder has no value.
 */
export function resolveAdopted(
  root: string,
  file: string,
  dirs: Omit<AdoptFiles, "files">,
): string | undefined {
  let missing = false
  const filled = file.replace(/\{(gitDir|gitCommonDir)\}/g, (_, name) => {
    const dir = dirs[name as "gitDir" | "gitCommonDir"]
    if (!dir) {
      missing = true
      return ""
    }
    return dir
  })
  if (missing) {
    return undefined
  }
  return path.isAbsolute(filled) ? filled : path.join(root, filled)
}

type RawLegacy = {
  branch?: unknown
  linearId?: unknown
  issueId?: unknown
  sentryRefs?: unknown
}

function readStateFile(file: string): RawLegacy | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RawLegacy)
      : undefined
  } catch {
    return undefined
  }
}

function fromLegacy(state: RawLegacy): LegacyState {
  const refs = Array.isArray(state.sentryRefs) ? state.sentryRefs : []
  const issue = [state.linearId, state.issueId].find(
    (id): id is string => typeof id === "string" && id !== "",
  )
  return {
    ...(issue ? { issue } : {}),
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

// --- arguments ---------------------------------------------------------------

type Args = { positional: string[]; flags: Map<string, string[]> }

/** Flags that take no value; every other flag takes the next argument. */
const SWITCHES = new Set(["remote", "no-markers"])

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
  let baseRef: string | undefined
  if (mode !== "remote") {
    run("git", ["fetch", "--quiet", "origin", base])
    baseRef = fetchedBaseRef(base)
  } else {
    baseRef = baseRefOf(base)
  }
  const head = git(["rev-parse", "HEAD"]) ?? "none"
  const dirty = (git(["status", "--porcelain"]) ?? "") !== ""
  const ahead = baseRef ? count(`${baseRef}..HEAD`) : 0
  const behind = baseRef ? count(`HEAD..${baseRef}`) : 0
  const upstream = `refs/remotes/origin/${branch}`
  const unpushed =
    refExists(upstream) && remoteHasBranch(branch) !== false
      ? count(`origin/${branch}..HEAD`)
      : undefined

  const dir = stateDir()
  let stored = readBranchState(dir, branch)
  let changed = false
  // A branch an earlier sync tool synced keeps its issue and error refs. Read
  // once, so an issue a later sync drops doesn't come back.
  if (!stored?.legacyRead) {
    const legacy = legacyOf(branch)
    stored = {
      ...stored,
      ...(legacy?.issue && !stored?.issue ? { issue: legacy.issue } : {}),
      errorRefs: [
        ...new Set([
          ...(stored?.errorRefs ?? []),
          ...(legacy?.errorRefs ?? []),
        ]),
      ],
      // bitfab-dev's sync wrote the PR, so keep writing it the way it does.
      // A tool the config adopts has its format set there instead.
      ...(legacy && !legacy.adopted && !stored?.format
        ? { format: syncFormat({ sync: BITFAB_DEV_FORMAT }) }
        : {}),
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
    writeBranchState(dir, branch, stored)
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
    format: readFormat(current?.format),
    projects: surveyProjects(baseRef),
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
  const baseRef = fetchedBaseRef(base)
  const head = git(["rev-parse", "HEAD"]) ?? "none"
  const ahead = count(`${baseRef}..HEAD`)
  const stored = readBranchState(stateDir(), branch)
  const full = stored?.remote?.head !== head
  printJson({
    workState: workState(pr, ahead),
    lastSyncedLine: lastSyncedLine(head),
    // Only the pull request's state moved: refresh state and links, not prose.
    updateKind: full ? "full" : "metadata-only",
    ...(full
      ? {
          commits: commitsOf(baseRef, syncSection().commitBodies === true),
          diffStat: git(["diff", "--stat", `${baseRef}...HEAD`]) ?? "",
        }
      : {}),
  })
}

/** Commits `facts` gives the most of, and the characters their bodies may take. */
export const COMMIT_LIMIT = 20
export const COMMIT_BODY_CHARS = 8000

/**
 * The branch's commits: one line each, or, with `bodies`, each one's subject
 * and body (newest first, at most COMMIT_LIMIT, cut at COMMIT_BODY_CHARS), for
 * a repo whose commit messages carry notes the PR body draws on.
 */
function commitsOf(baseRef: string, bodies: boolean): string {
  if (!bodies) {
    return git(["log", "--oneline", `${baseRef}..HEAD`]) ?? ""
  }
  const text =
    git([
      "log",
      `-${COMMIT_LIMIT}`,
      "--format=commit %h%n%B",
      `${baseRef}..HEAD`,
    ]) ?? ""
  return capText(text, COMMIT_BODY_CHARS)
}

/** `text`, cut at `max` characters with a note saying so. */
export function capText(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[cut at ${max} characters]`
}

/** The config's `sync` section, or nothing. */
function syncSection(): Record<string, unknown> {
  const root = git(["rev-parse", "--show-toplevel"])
  const section = root ? loadConfig(root).config?.sync : undefined
  return section && typeof section === "object"
    ? (section as Record<string, unknown>)
    : {}
}

/**
 * An earlier sync tool's state for `branch`: bitfab-dev's, then the files the
 * config's `sync.adoptState` names.
 */
function legacyOf(branch: string): LegacyState | undefined {
  const root = git(["rev-parse", "--show-toplevel"])
  if (!root) {
    return undefined
  }
  const adopt = syncSection().adoptState
  return readLegacyState(root, branch, {
    files: Array.isArray(adopt)
      ? adopt.filter((f): f is string => typeof f === "string")
      : [],
    gitDir: git(["rev-parse", "--absolute-git-dir"]),
    gitCommonDir: git([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
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
  const markers = !args.flags.has("no-markers")
  const adoptHeader = flag(args, "adopt-header")
  process.stdout.write(spliceBlock(body, block, { markers, adoptHeader }))
}

function description(args: Args): void {
  const file = required(args, "file")
  const before = fs.readFileSync(file, "utf8")
  const after = issueDescription(before, flag(args, "last-synced"))
  fs.writeFileSync(file, after)
  console.log(before === after ? "UNCHANGED" : `CHANGED ${file}`)
}

function finish(args: Args): void {
  const base = required(args, "base")
  const pr = parsePr(required(args, "pr"))
  const branch = currentBranch()
  const baseRef = baseRefOf(base)
  const head = git(["rev-parse", "HEAD"]) ?? "none"
  const dir = stateDir()
  const entry: BranchState = { ...readBranchState(dir, branch) }
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
    entry.format = readFormat(entry.format)
  }
  writeBranchState(dir, branch, entry)
  printJson({ written: true, branch, head })
}

const USAGE = `Usage: sync.ts <command>

  survey <default|local|remote> --base <branch> --pr <pr> [--error-ref <ref>]...
                  Fetch the base (not in remote mode), read git state, and
                  print it with the gate: runLocal, runRemote, noop, and the
                  branch's sync format (the config's sync section, then the
                  format it was last written in). Error refs are remembered
                  for the branch until a remote sync links them.
  facts --base <branch> --pr <pr>
                  For the remote writes: the issue's workState, the
                  lastSyncedLine, updateKind (full or metadata-only), and, for
                  a full update, commits and diffStat against the base
                  (commits with their bodies when sync.commitBodies is set).
  splice --body <file> --block <file> [--no-markers] [--adopt-header <regex>]
                  Print the pull request body with sync's block replaced (or
                  added on top, in place of the sections an earlier sync tool
                  wrote), leaving the rest of the body alone. --no-markers
                  writes the block without markers, the old one ending at its
                  last-synced line. --adopt-header (sync.adoptHeader): a body
                  whose first line matches it was written by another tool,
                  whose header lines and same-named sections it replaces.
  description --file <file> [--last-synced <line>]
                  Ready an issue description for writing, in place: each
                  document tag the tracker's MCP shows (<document … />) back
                  to the [title](url) link it stores, repairing a link an
                  earlier write nested, and, with --last-synced (facts'
                  lastSyncedLine, when the file has it), any older
                  last-synced line dropped. Prints CHANGED <file> or
                  UNCHANGED.
  issue           The issue a sync recorded for the current branch (or an
                  earlier sync tool left for it), as {"branch", "issue"}, with
                  issue null when there's none. Reads only.
  finish --base <branch> --pr <pr> [--remote] [--issue <id|none>] [--linked-ref <ref>]...
                  Record this sync so the next one can skip what's unchanged.
                  --remote when the pull request and issue were written (or
                  already current), which also records the format written.
                  --issue none forgets the cached issue.

<pr> is \`none\` or \`<number>:<open|merged|closed>:<true|false>\` (draft).
State is kept per branch in the repo's git common dir, shared by its
worktrees. A branch with no state yet starts from the issue and error refs
bitfab-dev's sync left in .bitfab-dev/state.json, when they're for that
branch, and from that tool's format; or, failing that, from another tool's
state file the config's sync.adoptState names ({gitDir} and {gitCommonDir}
are this worktree's git dirs), in the format the config sets.
survey and facts stop when origin/<base> is missing after the fetch.`

/**
 * The issue a sync recorded for the current branch, or one an earlier sync
 * tool left for it. Reads only: for a flow that needs the branch's issue
 * without syncing (close).
 */
function issue(_args: Args): void {
  const branch = currentBranch()
  const stored = readBranchState(stateDir(), branch)
  const legacy =
    stored?.issue || stored?.legacyRead ? undefined : legacyOf(branch)
  printJson({ branch, issue: stored?.issue ?? legacy?.issue ?? null })
}

const SUBCOMMANDS: Record<string, (args: Args) => void> = {
  survey,
  facts,
  splice,
  description,
  finish,
  issue,
}

export function main(argv: string[]): void {
  runSubcommand(argv, USAGE, SUBCOMMANDS, parseArgs)
}

if (isMain(import.meta.filename)) {
  runMain(() => main(process.argv.slice(2)))
}

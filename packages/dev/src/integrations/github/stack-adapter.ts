// GitHub's stacking ops as code, for stacks of plain pull requests whose base
// is another branch (no stacking tool). A branch's parent is recorded in git
// config, `branch.<branch>.stackParent`, which `git branch -m` carries and
// `git branch -D` drops; else it's read from the host: its pull request's
// base, when that base is itself a stacked branch. Catching up merges the
// parent in, never rebases, so a push never needs force; only moving off a
// parent that landed replays the branch's own commits, and the push after it
// may overwrite only the remote tip it replaced.
//
// Runtime code: Node built-ins only.

import { spawnSync } from "node:child_process"
import type { Adapter, AdapterInput } from "../../config/types.ts"
import { type Downstack, downstackOf } from "../graphite/adapter.ts"

/** Far deeper than any real stack: a guard against a cycle. */
const MAX_DEPTH = 50

export type RunResult = { status: number; stdout: string; stderr: string }

/** How the ops reach git and `gh`: the real ones, or a test's fakes. */
export type Shell = {
  run(bin: string, args: string[]): RunResult
  sleep(seconds: number): Promise<void>
}

export const systemShell: Shell = {
  run(bin, args) {
    const result = spawnSync(bin, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
    return {
      status: result.error ? 127 : (result.status ?? 1),
      stdout: result.stdout ?? "",
      stderr: result.stderr || (result.error ? String(result.error) : ""),
    }
  },
  sleep: (seconds) =>
    new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
}

/** What every op works from: the shell, the repository, and the base branch. */
export type StackContext = { sh: Shell; repo: string; base?: string }

export type OpenPr = {
  number: number
  url: string
  headRefName: string
  baseRefName: string
  isDraft: boolean
}

const RECORD = "stackParent"
const LEASE = "stackLease"

function out(sh: Shell, bin: string, args: string[]): string {
  const result = sh.run(bin, args)
  if (result.status !== 0) {
    throw new Error(
      `\`${bin} ${args.join(" ")}\` failed: ${(result.stderr || result.stdout).trim()}`,
    )
  }
  return result.stdout.trim()
}

function git(sh: Shell, args: string[]): string | undefined {
  const result = sh.run("git", args)
  return result.status === 0 ? result.stdout.trim() : undefined
}

function currentBranch(sh: Shell): string {
  const branch = git(sh, ["branch", "--show-current"])
  if (!branch) {
    throw new Error("HEAD is detached: check out a branch first")
  }
  return branch
}

export function contextOf(input: AdapterInput, sh: Shell): StackContext {
  return {
    sh,
    repo: `${input.values.owner}/${input.values.repo}`,
    ...(input.base ? { base: input.base } : {}),
  }
}

/** Every open pull request of the repository. A failed read throws. */
export function openPrs(ctx: StackContext): OpenPr[] {
  return JSON.parse(
    out(ctx.sh, "gh", [
      "pr",
      "list",
      "--repo",
      ctx.repo,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,url,headRefName,baseRefName,isDraft",
    ]) || "[]",
  ) as OpenPr[]
}

/** Every branch's recorded parent. */
export function recordedParents(sh: Shell): Map<string, string> {
  const records = new Map<string, string>()
  const text = git(sh, [
    "config",
    "--get-regexp",
    `^branch\\..*\\.${RECORD.toLowerCase()}$`,
  ])
  for (const line of text ? text.split(/\r?\n/) : []) {
    const space = line.indexOf(" ")
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? "" : line.slice(space + 1).trim()
    const branch = key.slice("branch.".length, -`.${RECORD}`.length)
    if (branch && value) {
      records.set(branch, value)
    }
  }
  return records
}

/**
 * Record `parent` as the branch's parent; a parent that's the base clears
 * the record, since a branch on the base isn't stacked.
 */
export function recordParent(
  ctx: StackContext,
  branch: string,
  parent: string,
): boolean {
  if (parent === ctx.base) {
    ctx.sh.run("git", ["config", "--unset", `branch.${branch}.${RECORD}`])
    return false
  }
  out(ctx.sh, "git", ["config", `branch.${branch}.${RECORD}`, parent])
  return true
}

const SHA = /^[0-9a-f]{7,40}$/i

function shortName(ref: string): string {
  return ref
    .replace(/^refs\/heads\//, "")
    .replace(/^(refs\/remotes\/)?origin\//, "")
}

/**
 * The branch `branch` was created from, from git's reflogs: its own first
 * entry (`branch: Created from <start>`), else, when that names HEAD or a
 * commit, the checkout that first moved onto it (`checkout: moving from <x>
 * to <branch>`).
 */
export function createdFrom(sh: Shell, branch: string): string | undefined {
  const lines = (args: string[]) =>
    (git(sh, ["reflog", "show", "--format=%gs", ...args]) ?? "")
      .split(/\r?\n/)
      .filter(Boolean)
  const first = lines([`refs/heads/${branch}`]).at(-1)
  let from = first?.match(/^branch: Created from (.+)$/)?.[1]?.trim()
  if (!from || from === "HEAD" || SHA.test(from)) {
    from = lines(["HEAD"])
      .map((line) => line.match(/^checkout: moving from (.+) to (.+)$/))
      .filter((m) => m?.[2] === branch)
      .at(-1)?.[1]
  }
  const name = from ? shortName(from) : undefined
  return name && name !== branch && !SHA.test(name) ? name : undefined
}

/** Whether `branch` heads a pull request that merged. A failed read throws. */
function headsMergedPr(ctx: StackContext, branch: string): boolean {
  const found = JSON.parse(
    out(ctx.sh, "gh", [
      "pr",
      "list",
      "--repo",
      ctx.repo,
      "--head",
      branch,
      "--state",
      "merged",
      "--limit",
      "1",
      "--json",
      "number",
    ]) || "[]",
  ) as unknown[]
  return found.length > 0
}

export type Parent = {
  parent: string
  source: "recorded" | "pull request" | "created from"
}

/**
 * `branch`'s parent: its recorded one; else its open pull request's base,
 * when that base heads an open or merged pull request of its own (a base
 * that doesn't is the trunk, or a pull request opened against the wrong
 * branch); else, with no pull request yet, the branch it was created from,
 * when that one heads an open pull request. Undefined means it isn't stacked.
 */
export function findParent(
  ctx: StackContext,
  branch: string,
  known: { prs?: OpenPr[]; records?: Map<string, string> } = {},
): Parent | undefined {
  const records = known.records ?? recordedParents(ctx.sh)
  const recorded = records.get(branch)
  if (recorded) {
    return { parent: recorded, source: "recorded" }
  }
  const prs = known.prs ?? openPrs(ctx)
  const heads = new Set(prs.map((pr) => pr.headRefName))
  const own = prs.find((pr) => pr.headRefName === branch)
  if (own) {
    const base = own.baseRefName
    if (
      base !== ctx.base &&
      base !== branch &&
      (heads.has(base) || headsMergedPr(ctx, base))
    ) {
      return { parent: base, source: "pull request" }
    }
    return undefined
  }
  const from = createdFrom(ctx.sh, branch)
  if (from && from !== ctx.base && heads.has(from)) {
    return { parent: from, source: "created from" }
  }
  return undefined
}

function notStacked(branch: string): Error {
  return new Error(
    `${branch} isn't stacked: no parent is recorded (git config branch.${branch}.${RECORD}), its pull request's base isn't another stacked branch, and it wasn't created from a branch with an open pull request`,
  )
}

/** `branch`'s chain bottom first, and its stack's counts, as `downstack` prints them. */
export function stackOf(
  ctx: StackContext,
  branch: string,
  prs: OpenPr[],
  records: Map<string, string>,
): Downstack {
  // Each open pull request's head stacks on its recorded parent, else its base.
  const parents = new Map<string, string>()
  for (const pr of prs) {
    parents.set(pr.headRefName, records.get(pr.headRefName) ?? pr.baseRefName)
  }
  const own = findParent(ctx, branch, { prs, records })
  if (own) {
    parents.set(branch, own.parent)
  } else {
    parents.delete(branch)
  }
  // Down the chain, a parent is stacked while it heads an open pull request
  // or has a parent recorded (one that merged: merge then calls it stale).
  // The first that's neither is the trunk.
  let trunk = ctx.base ?? ""
  const seen = [branch]
  let cursor = branch
  while (seen.length < MAX_DEPTH) {
    const parent = parents.get(cursor)
    if (!parent || parent === ctx.base || seen.includes(parent)) {
      break
    }
    if (!parents.has(parent)) {
      const recorded = records.get(parent)
      if (!recorded) {
        trunk = parent
        break
      }
      parents.set(parent, recorded)
    }
    seen.push(parent)
    cursor = parent
  }
  return downstackOf(branch, trunk, parents)
}

function fetch(sh: Shell, ...refs: string[]): void {
  out(sh, "git", ["fetch", "origin", ...refs])
}

function revParse(sh: Shell, ref: string): string | undefined {
  return git(sh, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])
}

function isAncestor(sh: Shell, ancestor: string, of: string): boolean {
  return (
    sh.run("git", ["merge-base", "--is-ancestor", ancestor, of]).status === 0
  )
}

function ownOpenPr(ctx: StackContext, branch: string): OpenPr | undefined {
  const prs = JSON.parse(
    out(ctx.sh, "gh", [
      "pr",
      "list",
      "--repo",
      ctx.repo,
      "--head",
      branch,
      "--state",
      "open",
      "--limit",
      "1",
      "--json",
      "number,url,headRefName,baseRefName,isDraft",
    ]) || "[]",
  ) as OpenPr[]
  return prs[0]
}

function retarget(
  ctx: StackContext,
  pr: OpenPr | undefined,
  onto: string,
): boolean {
  if (!pr || pr.baseRefName === onto) {
    return false
  }
  out(ctx.sh, "gh", [
    "pr",
    "edit",
    String(pr.number),
    "--repo",
    ctx.repo,
    "--base",
    onto,
  ])
  return true
}

// ---- the ops ----

export async function parentOp(ctx: StackContext): Promise<Parent> {
  const branch = currentBranch(ctx.sh)
  const found = findParent(ctx, branch)
  if (!found) {
    throw notStacked(branch)
  }
  return found
}

export async function trackOp(
  ctx: StackContext,
  parent: string,
): Promise<{ branch: string; parent: string; recorded: boolean }> {
  const branch = currentBranch(ctx.sh)
  if (parent === branch) {
    throw new Error(`${branch} can't be stacked on itself`)
  }
  // Only on a stacked branch: recording any other base (a pull request
  // opened by hand against the wrong branch) would get it past finish's gate.
  if (
    parent !== ctx.base &&
    !openPrs(ctx).some((pr) => pr.headRefName === parent) &&
    !headsMergedPr(ctx, parent)
  ) {
    throw new Error(
      `${parent} isn't a stacked branch (it heads no open or merged pull request), so ${branch} isn't stacked on it: open ${parent}'s pull request first, or retarget ${branch}'s to the base`,
    )
  }
  return { branch, parent, recorded: recordParent(ctx, branch, parent) }
}

export async function downstackOp(ctx: StackContext): Promise<Downstack> {
  const branch = currentBranch(ctx.sh)
  return stackOf(ctx, branch, openPrs(ctx), recordedParents(ctx.sh))
}

/** The parent to catch up to: the stacked one, else the base. */
function parentOrBase(ctx: StackContext, branch: string): string {
  const parent = findParent(ctx, branch)?.parent ?? ctx.base
  if (!parent) {
    throw notStacked(branch)
  }
  return parent
}

export async function restackOp(
  ctx: StackContext,
): Promise<{ branch: string; parent: string; merged: number }> {
  const branch = currentBranch(ctx.sh)
  const parent = parentOrBase(ctx, branch)
  try {
    fetch(ctx.sh, parent)
  } catch (error) {
    throw new Error(
      `${(error as Error).message}. When ${parent} merged and its branch was deleted, move ${branch} off it with the reparent op instead`,
    )
  }
  const behind = Number(
    git(ctx.sh, ["rev-list", "--count", `HEAD..origin/${parent}`]) ?? "0",
  )
  if (behind === 0) {
    return { branch, parent, merged: 0 }
  }
  const merge = ctx.sh.run("git", ["merge", "--no-edit", `origin/${parent}`])
  if (merge.status !== 0) {
    throw new Error(
      `merging origin/${parent} into ${branch} stopped on conflicts: resolve each file, \`git add\` it, then the continue op (\`git commit --no-edit\`). ${(merge.stdout || merge.stderr).trim()}`,
    )
  }
  return { branch, parent, merged: behind }
}

/**
 * The last commit of `old`, a parent that merged: its merged pull request's
 * head (fetched from the host when it isn't here), else its remote or local
 * branch. Undefined when none of them is in this checkout.
 */
function landedTip(ctx: StackContext, old: string): string | undefined {
  const merged = JSON.parse(
    ctx.sh.run("gh", [
      "pr",
      "list",
      "--repo",
      ctx.repo,
      "--head",
      old,
      "--state",
      "merged",
      "--limit",
      "1",
      "--json",
      "number,headRefOid",
    ]).stdout || "[]",
  ) as { number: number; headRefOid: string }[]
  const head = merged[0]
  if (head) {
    if (!revParse(ctx.sh, head.headRefOid)) {
      ctx.sh.run("git", ["fetch", "origin", `refs/pull/${head.number}/head`])
    }
    if (revParse(ctx.sh, head.headRefOid)) {
      return head.headRefOid
    }
  }
  return (
    revParse(ctx.sh, `refs/remotes/origin/${old}`) ??
    revParse(ctx.sh, `refs/heads/${old}`)
  )
}

export async function reparentOp(
  ctx: StackContext,
  old: string,
  onto: string,
): Promise<{
  branch: string
  old: string
  onto: string
  from: string
  retargeted: boolean
}> {
  const branch = currentBranch(ctx.sh)
  fetch(ctx.sh, onto)
  ctx.sh.run("git", ["fetch", "origin", branch])
  const remote = revParse(ctx.sh, `refs/remotes/origin/${branch}`)
  if (remote && !isAncestor(ctx.sh, remote, "HEAD")) {
    throw new Error(
      `origin/${branch} has commits this checkout doesn't: \`git merge origin/${branch}\` first, so moving the branch keeps them`,
    )
  }
  const tip = landedTip(ctx, old)
  if (!tip) {
    throw new Error(
      `${old} merged, but its last commit isn't in this checkout, so ${branch}'s own commits can't be told apart from it. Find that commit and run: git rebase --onto origin/${onto} <that commit>`,
    )
  }
  const from = out(ctx.sh, "git", ["merge-base", "HEAD", tip])
  recordParent(ctx, branch, onto)
  if (remote) {
    // The push after this replaces exactly this tip, and nothing pushed since.
    out(ctx.sh, "git", ["config", `branch.${branch}.${LEASE}`, remote])
  }
  const retargeted = retarget(ctx, ownOpenPr(ctx, branch), onto)
  const rebase = ctx.sh.run("git", ["rebase", "--onto", `origin/${onto}`, from])
  if (rebase.status !== 0) {
    throw new Error(
      `moving ${branch} onto origin/${onto} stopped on conflicts: resolve each file, \`git add\` it, then \`GIT_EDITOR=true git rebase --continue\` until it finishes. Its parent is already recorded as ${onto}. ${(rebase.stdout || rebase.stderr).trim()}`,
    )
  }
  return { branch, old, onto, from, retargeted }
}

export async function submitOp(ctx: StackContext): Promise<{
  branch: string
  parent: string
  url: string
  created: boolean
  retargeted: boolean
  forced: boolean
}> {
  const branch = currentBranch(ctx.sh)
  const parent = parentOrBase(ctx, branch)
  let forced = false
  const push = ctx.sh.run("git", ["push", "-u", "origin", "HEAD"])
  if (push.status !== 0) {
    const lease = git(ctx.sh, ["config", "--get", `branch.${branch}.${LEASE}`])
    if (!lease) {
      throw new Error(
        `the push of ${branch} was refused: ${(push.stderr || push.stdout).trim()}. When origin/${branch} has commits this branch doesn't, \`git fetch origin ${branch}\` and \`git merge origin/${branch}\`, then submit again. Never force-push it`,
      )
    }
    out(ctx.sh, "git", [
      "push",
      `--force-with-lease=refs/heads/${branch}:${lease}`,
      "-u",
      "origin",
      "HEAD",
    ])
    forced = true
  }
  ctx.sh.run("git", ["config", "--unset", `branch.${branch}.${LEASE}`])
  const pr = ownOpenPr(ctx, branch)
  let url: string
  let created = false
  let retargeted = false
  if (pr) {
    url = pr.url
    retargeted = retarget(ctx, pr, parent)
  } else {
    url =
      out(ctx.sh, "gh", [
        "pr",
        "create",
        "--repo",
        ctx.repo,
        "--draft",
        "--base",
        parent,
        "--head",
        branch,
        "--fill",
      ])
        .split(/\r?\n/)
        .at(-1) ?? ""
    created = true
  }
  recordParent(ctx, branch, parent)
  return { branch, parent, url, created, retargeted, forced }
}

export type StackMerge = {
  ok: boolean
  method: "merge"
  merged: { branch: string; pr: number }[]
  failure?: { branch: string; error: string }
  remoteRefs: Record<string, string>
}

type PrView = { mergeable?: string; headRefOid?: string; state?: string }

function viewPr(ctx: StackContext, pr: number, fields: string): PrView {
  const result = ctx.sh.run("gh", [
    "pr",
    "view",
    String(pr),
    "--repo",
    ctx.repo,
    "--json",
    fields,
  ])
  try {
    return result.status === 0 ? (JSON.parse(result.stdout) as PrView) : {}
  } catch {
    return {}
  }
}

/** Lands one pull request of the chain into `trunk`; an error says why it couldn't. */
async function landOne(
  ctx: StackContext,
  pr: OpenPr,
  trunk: string,
  head: string,
): Promise<string | undefined> {
  const fail = (what: string, result: RunResult) =>
    `${what} failed: ${(result.stderr || result.stdout).trim()}`
  const n = String(pr.number)
  if (pr.isDraft) {
    const ready = ctx.sh.run("gh", ["pr", "ready", n, "--repo", ctx.repo])
    if (ready.status !== 0) {
      return fail(`marking #${n} ready`, ready)
    }
  }
  if (pr.baseRefName !== trunk) {
    const edit = ctx.sh.run("gh", [
      "pr",
      "edit",
      n,
      "--repo",
      ctx.repo,
      "--base",
      trunk,
    ])
    if (edit.status !== 0) {
      return fail(`retargeting #${n} to ${trunk}`, edit)
    }
  }
  let view = viewPr(ctx, pr.number, "mergeable,headRefOid")
  for (let i = 0; i < 20 && (view.mergeable ?? "UNKNOWN") === "UNKNOWN"; i++) {
    await ctx.sh.sleep(3)
    view = viewPr(ctx, pr.number, "mergeable,headRefOid")
  }
  if (view.mergeable === "CONFLICTING") {
    return `#${n} conflicts with ${trunk} once retargeted: sync it, then merge again`
  }
  if (view.headRefOid !== head) {
    return `#${n}'s head is ${view.headRefOid ?? "unreadable"}, not origin/${pr.headRefName} (${head}): it moved, so nothing past it merges`
  }
  const merge = ctx.sh.run("gh", [
    "pr",
    "merge",
    n,
    "--repo",
    ctx.repo,
    "--merge",
    "--match-head-commit",
    head,
  ])
  if (merge.status !== 0) {
    return fail(`merging #${n}`, merge)
  }
  let state = viewPr(ctx, pr.number, "state").state
  for (let i = 0; i < 10 && state !== "MERGED"; i++) {
    await ctx.sh.sleep(3)
    state = viewPr(ctx, pr.number, "state").state
  }
  return state === "MERGED" ? undefined : `#${n} didn't reach merged`
}

function deleteRemote(ctx: StackContext, branch: string): string {
  const children = ctx.sh.run("gh", [
    "pr",
    "list",
    "--repo",
    ctx.repo,
    "--base",
    branch,
    "--state",
    "open",
    "--json",
    "number",
  ])
  if (children.status !== 0) {
    return `kept: its stacked pull requests couldn't be listed (${(children.stderr || children.stdout).trim()})`
  }
  const open = (JSON.parse(children.stdout || "[]") as unknown[]).length
  if (open > 0) {
    return `kept: ${open} open pull request(s) target it`
  }
  const result = ctx.sh.run("gh", [
    "api",
    "-X",
    "DELETE",
    `repos/${ctx.repo}/git/refs/heads/${branch}`,
  ])
  if (result.status === 0) {
    return "deleted"
  }
  return /Reference does not exist/i.test(result.stderr + result.stdout)
    ? "already gone"
    : `failed: ${(result.stderr || result.stdout).trim()}`
}

/**
 * Lands the checked-out branch's chain bottom first: each pull request is
 * marked ready, retargeted to the trunk, merged with a merge commit pinned to
 * the head that was pushed, and waited on until the host says merged, so the
 * next one's own commits are all that's left of it. Then the remote branches
 * below the checked-out one are deleted, unless a pull request still targets
 * one.
 */
export async function mergeStackOp(ctx: StackContext): Promise<StackMerge> {
  const branch = currentBranch(ctx.sh)
  const prs = openPrs(ctx)
  const { chain } = stackOf(ctx, branch, prs, recordedParents(ctx.sh))
  const byHead = new Map(prs.map((pr) => [pr.headRefName, pr]))
  const trunk = ctx.base ?? byHead.get(chain[0])?.baseRefName
  if (!trunk) {
    throw new Error("the repo's base branch isn't known: set repo.baseBranch")
  }
  fetch(ctx.sh, ...chain)
  const heads = new Map<string, string>()
  const differ: string[] = []
  for (const name of chain) {
    const remote = revParse(ctx.sh, `refs/remotes/origin/${name}`)
    const local = revParse(ctx.sh, `refs/heads/${name}`)
    if (remote) {
      heads.set(name, remote)
    }
    if (!remote || (local && local !== remote)) {
      differ.push(name)
    }
  }
  if (differ.length > 0) {
    throw new Error(
      `local branches differ from their remotes (${differ.join(", ")}), so nothing merged: sync each, then merge again`,
    )
  }
  const merged: StackMerge["merged"] = []
  let failure: StackMerge["failure"]
  for (const name of chain) {
    const pr = byHead.get(name)
    const error = pr
      ? await landOne(ctx, pr, trunk, heads.get(name) as string)
      : `${name} has no open pull request`
    if (error || !pr) {
      failure = { branch: name, error: error ?? "" }
      break
    }
    merged.push({ branch: name, pr: pr.number })
  }
  const remoteRefs: Record<string, string> = {}
  for (const { branch: name } of merged) {
    if (name !== branch) {
      remoteRefs[name] = deleteRemote(ctx, name)
    }
  }
  return {
    ok: !failure,
    method: "merge",
    merged,
    ...(failure ? { failure } : {}),
    remoteRefs,
  }
}

// ---- as adapters ----

function adapter(
  op: (ctx: StackContext, args: Record<string, string>) => Promise<unknown>,
  args: string[] = [],
): Adapter {
  return {
    needs: "cli",
    args,
    run: (input) => op(contextOf(input, systemShell), input.args),
  }
}

export const stackAdapters: Record<string, Adapter> = {
  parent: adapter((ctx) => parentOp(ctx)),
  track: adapter((ctx, args) => trackOp(ctx, args.parent), ["parent"]),
  downstack: adapter((ctx) => downstackOp(ctx)),
  restack: adapter((ctx) => restackOp(ctx)),
  reparent: adapter(
    (ctx, args) => reparentOp(ctx, args.old, args.onto),
    ["old", "onto"],
  ),
  submit: adapter((ctx) => submitOp(ctx)),
  mergeStack: adapter((ctx) => mergeStackOp(ctx)),
}

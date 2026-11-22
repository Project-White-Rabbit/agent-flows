// The mechanical half of the start-work and start-ticket-queue flows: which
// tickets get a workspace, on which branch, with what prompt, and the order
// start-ticket-queue goes through them in. Everything vendor-specific (reading
// issues, opening workspaces, moving issues) stays in the skills, which reach
// it through the configured integrations' ops and pass what they read in here
// as a JSON file.
//
// Git worktrees are read here directly: a branch checked out in any worktree
// of the repo already has someone on it, whichever app opened it.

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  addBranchLine,
  branchFromDescription,
  withoutLinkLines,
} from "../config/branch-line.ts"
import { plainDocumentLinks } from "../config/links.ts"
import {
  DATE_TOKENS,
  DEFAULT_RANKS,
  DEFAULT_WORKSPACE_NAME,
  projectRepositories,
  ranksProblem,
  WORKSPACE_NAME_PLACEHOLDER,
} from "../config/sections/tickets.ts"
import { worktreePaths } from "../integrations/worktree/spec.ts"
import { repoRoot } from "./configure.ts"
import {
  type Flags,
  isMain,
  parseFlags,
  readJson,
  requiredFlag,
  run,
  runMain,
  runSubcommand,
  stateDir,
  USAGE_EXIT,
  UsageError,
} from "./lib.ts"
import {
  type Priority,
  priorityNamed,
  readRules,
  PRIORITIES as TRACKER_PRIORITIES,
} from "./tickets.ts"

/** The issue tracker's priorities, most urgent first, then none. */
export const PRIORITIES = TRACKER_PRIORITIES

/** Workflow states as the issue tracker's `updateIssue` op names them. */
export type Stage = "todo" | "in progress" | "in review" | "done" | "canceled"

/** An issue as the tracker's `getIssue` op returned it, or not found. */
export type Ticket = {
  id: string
  title?: string
  url?: string
  description?: string | null
  stage?: Stage
  priority?: Priority
  /** The branch name the tracker suggests for it. */
  branchName?: string | null
  /** Its label by the kind of work, for `{category}` in a workspace name. */
  category?: string | null
  /** Its due date, `YYYY-MM-DD`, for `{due}` in a workspace name. */
  dueDate?: string | null
  /** `getIssue` found nothing. */
  missing?: boolean
}

/** An issue as the tracker's `assignedIssues` op returned it. */
export type Assigned = {
  id: string
  title: string
  url: string
  state?: string
  description?: string | null
  priority?: Priority
  dueDate?: string | null
  /** When it was filed: an ISO date or timestamp. */
  createdAt?: string | null
  /** Who filed it, by name. */
  creator?: string | null
  /** Its tracker project, by name. */
  project?: string | null
  openSubIssues?: boolean
  pullRequests?: string[]
  blocks?: boolean
  /** It's in a tracker entry at `link` (read-only). */
  link?: boolean
}

/** A repository as a workspaces integration's `repositories` op returned it. */
export type Repository = {
  /** What `--workspaces-repository` takes for it. */
  name: string
  /** Its origin, `<host>/<owner>/<repo>`. */
  remote?: string | null
  /** Its main checkout on this machine. */
  path?: string | null
  /** It's the repository this session runs in. */
  current?: boolean
}

/** A workspace as a workspaces integration's `workspaces` op returned it. */
export type Workspace = {
  integration?: string
  id?: string
  name?: string
  branch?: string | null
  section?: string | null
  current?: boolean
}

export type StartOptions = {
  /**
   * Every new workspace's section; null for none. Undefined: the current
   * one's, or none in another repository, whose sections aren't this one's.
   */
  section?: string | null
  /** The workspaces open in another repository (`--workspaces-repository`). */
  otherRepository?: boolean
  byRank?: boolean
  ranks?: string[]
  /** How a workspace on an issue is named (`tickets.workspaceName`). */
  workspaceName?: string
}

export type Start =
  | { action: "skip"; id: string; reason: string }
  | {
      action: "exists"
      id: string
      workspace: Workspace
      /** The ticket has no `> Branch:` line yet. */
      addLine: boolean
      /** The ticket hasn't been started, so it moves to in progress. */
      move: boolean
    }
  | {
      action: "start"
      id: string
      ticket: Ticket
      /** The new workspace's name. */
      name: string
      branch: string
      /** The branch came from the ticket's own `> Branch:` line. */
      exact: boolean
      section: string | null
      move: boolean
    }

const CLOSED: Stage[] = ["done", "canceled"]

/** Whether a branch name carries the issue id (`sam/eng-12-fix-login`). */
export function namesTicket(branch: string, id: string): boolean {
  const words = (branch.split("/").at(-1) ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  const [prefix, number] = id.toLowerCase().split("-")
  return words.some((word, i) => word === prefix && words[i + 1] === number)
}

/** The open workspace on a ticket's branch, or on a branch naming it. */
export function workspaceOn(
  workspaces: Workspace[],
  id: string,
  branch: string | undefined,
): Workspace | undefined {
  return workspaces.find(
    (w) => w.branch && (w.branch === branch || namesTicket(w.branch, id)),
  )
}

/** `text` as a branch name's words, cut at a word to at most `limit` characters. */
export function slugify(text: string, limit: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  if (slug.length <= limit) {
    return slug
  }
  // One character more, so a word that ends right at the limit stays whole.
  const cut = slug.slice(0, limit + 1)
  const end = cut.lastIndexOf("-")
  return end > 0 ? cut.slice(0, end) : slug.slice(0, limit)
}

/**
 * The branch for a new workspace: the ticket's `> Branch:` line exactly, else
 * the tracker's suggestion without its owner prefix (the workspace adds its
 * own), else the id and a slug of the title.
 */
export function branchFor(ticket: Ticket): { branch: string; exact: boolean } {
  const anchored = branchFromDescription(ticket.description)
  if (anchored) {
    return { branch: anchored, exact: true }
  }
  const suggested = ticket.branchName?.split("/").at(-1)?.trim()
  if (suggested) {
    return { branch: suggested, exact: false }
  }
  const slug = slugify(ticket.title ?? "", 40)
  return {
    branch: [ticket.id.toLowerCase(), slug].filter(Boolean).join("-"),
    exact: false,
  }
}

/**
 * A character that only separates a workspace name's parts: a space, one of
 * `/ | : , . · _ ~`, a hyphen, or an en or em dash.
 */
const SEPARATOR = "[\\s/|:,.·_~\\-\\u2013\\u2014]"

const SEPARATORS = `${SEPARATOR}*`

/** A bracketed part of a workspace name, `(…)` or `[…]`, with no brackets inside. */
const BRACKETED = /[([][^()[\]]*[)\]]/g

/** `text` with every regex metacharacter escaped. */
function escapeRegex(text: string): string {
  return text.replace(/[{}.*+?^$|()[\]\\-]/g, "\\$&")
}

/** `text` cut to at most `limit` characters, at a word when one ends in reach. */
export function cutAt(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  // One character more, so a word that ends right at the limit stays whole.
  const cut = text.slice(0, limit + 1)
  const end = cut.lastIndexOf(" ")
  const kept = end > 0 ? cut.slice(0, end) : text.slice(0, limit)
  return kept.replace(new RegExp(`${SEPARATOR}+$`), "")
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

/**
 * A `YYYY-MM-DD` date (or a timestamp that starts with one) in `format`, made
 * of `YYYY`, `YY`, `MMM` (`Nov`), `MM`, `M`, `DD`, and `D`: `MM/DD` reads
 * `11/30`. Anything that isn't such a date comes back as it is.
 */
export function formatDate(date: string, format: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) {
    return date
  }
  const [, year, month, day] = match
  const parts: Record<(typeof DATE_TOKENS)[number], string> = {
    YYYY: year,
    YY: year.slice(2),
    MMM: MONTHS[Number(month) - 1] ?? month,
    MM: month,
    M: String(Number(month)),
    DD: day,
    D: String(Number(day)),
  }
  return format.replace(
    new RegExp(DATE_TOKENS.join("|"), "g"),
    (token) => parts[token as keyof typeof parts],
  )
}

/** A workspace name's parts for an issue, before any form is applied. */
type NameValues = Record<
  "id" | "title" | "priority" | "category" | "due",
  string
>

function nameValues(ticket: Ticket, ranks: string[]): NameValues {
  return {
    id: ticket.id,
    title: ticket.title?.trim() ?? "",
    priority:
      ticket.priority && ticket.priority !== "none"
        ? rankName(ticket.priority, ranks)
        : "",
    category: ticket.category?.trim() ?? "",
    due: ticket.dueDate?.trim() ?? "",
  }
}

/** `template` filled in with `values`, dropping the parts that are empty. */
function fillName(template: string, values: NameValues): string {
  const fill = (key: string, form?: string): string => {
    const value = values[key as keyof NameValues]
    if (key === "due") {
      return value && form ? formatDate(value, form) : value.slice(0, 10)
    }
    if (form === "short") {
      return value.match(/(\d+)\D*$/)?.[1] ?? value
    }
    return form ? cutAt(value, Number(form)) : value
  }
  const empty = (text: string) => {
    const parts = [...text.matchAll(WORKSPACE_NAME_PLACEHOLDER)]
    return parts.length > 0 && parts.every(([, key, form]) => !fill(key, form))
  }
  // A part that drops out takes the separator before it, or the one after it
  // when it comes first.
  const drop = (name: string, part: string): string => {
    const at = name.indexOf(part)
    if (at < 0) {
      return name
    }
    const first = /^[\s([]*$/.test(name.slice(0, at))
    const pattern = escapeRegex(part)
    return name.replace(
      new RegExp(first ? pattern + SEPARATORS : SEPARATORS + pattern),
      "",
    )
  }
  let name = template
  // A bracketed part whose placeholders are all empty goes whole, with the
  // words around them: `(due {due})` leaves nothing behind.
  for (const [group] of template.matchAll(BRACKETED)) {
    if (empty(group)) {
      name = drop(name, group)
    }
  }
  for (const [token] of template.matchAll(WORKSPACE_NAME_PLACEHOLDER)) {
    if (empty(token)) {
      name = drop(name, token)
    }
  }
  return name
    .replace(WORKSPACE_NAME_PLACEHOLDER, (_, key: string, form?: string) =>
      fill(key, form),
    )
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * A workspace's name for an issue: `template` with its id (`{id:short}`: its
 * number), title, priority (the team's name for it, nothing for none),
 * category, and due date filled in, `{title:N}` and `{category:N}` cut to N
 * characters and `{due:FORMAT}` in that date format (`{due:MM/DD}`). A
 * part the issue doesn't have drops out with the separator before it, or the
 * one after it when it comes first, and so do the brackets it leaves empty:
 * `{priority}/{category}: {title}` with no category reads `P0: Fix it`. A
 * bracketed part with nothing filled in goes whole, its own words included:
 * `{title} (due {due:MMM D})` with no due date reads `Fix it`.
 */
export function workspaceName(
  ticket: Ticket,
  template: string = DEFAULT_WORKSPACE_NAME,
  ranks: string[] = DEFAULT_RANKS,
): string {
  return fillName(template, nameValues(ticket, ranks))
}

/** Stand-ins for the parts of a name that change: none can be in a real one. */
const STAND_INS = {
  title: "\uE000",
  priority: "\uE001",
  category: "\uE002",
  due: "\uE003",
} as const

/**
 * Whether `name` reads as `template` filled in for the issue `id`, whatever
 * its title, priority, category, and due date were then: the id where the
 * template puts it, and the template's own words and separators around the
 * rest. A name someone gave the workspace by hand doesn't, unless they kept
 * the template's shape. Without `{id}` in the template nothing tells the two
 * apart, so no name counts.
 */
export function followsTemplate(
  name: string,
  id: string,
  template: string = DEFAULT_WORKSPACE_NAME,
): boolean {
  if (!/\{id[:}]/.test(template)) {
    return false
  }
  const keys = Object.keys(STAND_INS) as (keyof typeof STAND_INS)[]
  // Every combination of the parts that can drop out, the title included.
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const values: NameValues = {
      id,
      title: "",
      priority: "",
      category: "",
      due: "",
    }
    keys.forEach((key, i) => {
      values[key] = mask & (1 << i) ? STAND_INS[key] : ""
    })
    let pattern = escapeRegex(fillName(template, values))
    for (const stand of Object.values(STAND_INS)) {
      pattern = pattern.replaceAll(stand, ".+?")
    }
    if (new RegExp(`^${pattern}$`).test(name.replace(/\s+/g, " ").trim())) {
      return true
    }
  }
  return false
}

/** What sync does with this workspace's name once its issue may have changed. */
export type Refresh =
  | { action: "rename"; name: string; from: string; section?: string }
  | { action: "keep"; name: string }
  | { action: "leave"; name: string; reason: string }

/**
 * The name this workspace takes now: the template filled in for the issue as
 * it is, when the current name followed the template (so a new title,
 * priority, or due date shows), and left alone when someone named it by hand.
 * A workspace in the section named for a priority (start-work's
 * `--section-by-rank`) moves to the one for the issue's priority now.
 */
export function refreshName(
  ticket: Ticket,
  workspace: Workspace,
  template: string = DEFAULT_WORKSPACE_NAME,
  ranks: string[] = DEFAULT_RANKS,
): Refresh {
  const current = workspace.name?.trim() ?? ""
  const name = workspaceName(ticket, template, ranks)
  const section = workspace.section?.trim()
  const rank = rankName(ticket.priority, ranks)
  const moves = section && ranks.includes(section) && section !== rank
  if (current !== name && !followsTemplate(current, ticket.id, template)) {
    return {
      action: "leave",
      name: current,
      reason: /\{id[:}]/.test(template)
        ? "named by hand"
        : "tickets.workspaceName has no {id}",
    }
  }
  if (current === name && !moves) {
    return { action: "keep", name }
  }
  return {
    action: "rename",
    name,
    from: current,
    ...(moves ? { section: rank } : {}),
  }
}

export function describeRefresh(refresh: Refresh): string {
  switch (refresh.action) {
    case "keep":
      return `KEEP name="${refresh.name}"`
    case "leave":
      return `LEAVE name="${refresh.name}" reason="${refresh.reason}"`
    case "rename":
      return `RENAME name="${refresh.name}" from="${refresh.from}" section=${refresh.section === undefined ? "keep" : `"${refresh.section}"`}`
  }
}

export function rankName(
  priority: Priority | undefined,
  ranks: string[] = DEFAULT_RANKS,
): string {
  return ranks[PRIORITIES.indexOf(priority ?? "none")] ?? ranks.at(-1) ?? ""
}

function notStarted(ticket: Ticket): boolean {
  return ticket.stage === undefined || ticket.stage === "todo"
}

/**
 * A new workspace's section without --section-by-rank: the one given, else
 * the current workspace's, or none in another repository, whose sections
 * aren't this one's.
 */
function sectionFor(
  workspaces: Workspace[],
  options: StartOptions,
): string | null {
  if (options.section !== undefined) {
    return options.section
  }
  if (options.otherRepository) {
    return null
  }
  return workspaces.find((w) => w.current)?.section?.trim() || null
}

export function planStart(
  ticket: Ticket,
  workspaces: Workspace[],
  options: StartOptions = {},
): Start {
  if (ticket.missing || !ticket.title) {
    return { action: "skip", id: ticket.id, reason: "not found" }
  }
  if (ticket.stage && CLOSED.includes(ticket.stage)) {
    return { action: "skip", id: ticket.id, reason: ticket.stage }
  }
  const anchored = branchFromDescription(ticket.description)
  const existing = workspaceOn(workspaces, ticket.id, anchored)
  if (existing) {
    return {
      action: "exists",
      id: ticket.id,
      workspace: existing,
      addLine: !anchored,
      move: notStarted(ticket),
    }
  }
  const section = options.byRank
    ? rankName(ticket.priority, options.ranks)
    : sectionFor(workspaces, options)
  return {
    action: "start",
    id: ticket.id,
    ticket,
    name: workspaceName(ticket, options.workspaceName, options.ranks),
    ...branchFor(ticket),
    section,
    move: notStarted(ticket),
  }
}

/** What the new workspace's agent starts on: the issue, minus its link lines. */
export function agentPrompt(ticket: Ticket): string {
  const body = withoutLinkLines(ticket.description ?? "")
  const head =
    `Work on issue ${ticket.id}: ${ticket.title}\n${ticket.url ?? ""}`.trim()
  return body ? `${head}\n\n${body}\n` : `${head}\n`
}

export function describeStart(start: Start, prompt?: string): string {
  if (start.action === "skip") {
    return `SKIP ${start.id} ${start.reason}`
  }
  const state = start.move ? "move" : "keep"
  if (start.action === "exists") {
    const line = start.addLine ? "add" : "keep"
    return `EXISTS ${start.id} workspace="${start.workspace.name ?? start.workspace.id}" branch=${start.workspace.branch} branch-line=${line} state=${state}`
  }
  const section = start.section === null ? "none" : `"${start.section}"`
  const promptPart = prompt ? ` prompt=${prompt}` : ""
  return `START ${start.id} "${start.ticket.title}" name="${start.name}" branch=${start.branch} exact=${start.exact ? "yes" : "no"} section=${section} state=${state}${promptPart}`
}

/** Untracked work in a new workspace, as `plan --title` decides it. */
export type Untracked =
  | {
      action: "start"
      title: string
      name: string
      branch: string
      section: string | null
    }
  | { action: "exists"; title: string; workspace: Workspace }

/**
 * Untracked work in a new workspace: named after its title, on a branch from
 * it (the integration adds its prefix), unless a workspace is on that branch.
 */
export function planUntracked(
  title: string,
  workspaces: Workspace[],
  options: StartOptions = {},
): Untracked {
  const branch = slugify(title, 60)
  if (!branch) {
    throw new UsageError(
      `the title \`${title}\` has no letters or digits to name a branch after`,
    )
  }
  const existing = workspaces.find(
    (w) => w.branch && w.branch.split("/").at(-1) === branch,
  )
  if (existing) {
    return { action: "exists", title: title.trim(), workspace: existing }
  }
  return {
    action: "start",
    title: title.trim(),
    name: title.trim(),
    branch,
    section: sectionFor(workspaces, options),
  }
}

/** What an untracked workspace's agent starts on: the title and the notes. */
export function untrackedPrompt(title: string, notes: string): string {
  const body = notes.trim()
  const head = `Work on: ${title.trim()}`
  return body && body !== title.trim() ? `${head}\n\n${body}\n` : `${head}\n`
}

export function describeUntracked(start: Untracked, prompt?: string): string {
  if (start.action === "exists") {
    return `EXISTS "${start.title}" workspace="${start.workspace.name ?? start.workspace.id}" branch=${start.workspace.branch}`
  }
  const section = start.section === null ? "none" : `"${start.section}"`
  const promptPart = prompt ? ` prompt=${prompt}` : ""
  return `START "${start.title}" name="${start.name}" branch=${start.branch} exact=no section=${section} state=keep${promptPart}`
}

/** Work on an issue, or on untracked work, in this workspace instead of a new one. */
export type Reuse = {
  action: "reuse"
  /** Undefined for work with no issue. */
  ticket?: Ticket
  /** The workspace's new name. */
  name: string
  /** This worktree's branch now. */
  from: string
  branch: string
  /** The section to move this workspace to; null for none, undefined to keep it. */
  section?: string | null
  addLine: boolean
  move: boolean
}

/** The `<owner>/` a branch sits under, or nothing. */
function branchPrefix(branch: string): string {
  return branch.includes("/")
    ? branch.slice(0, branch.lastIndexOf("/") + 1)
    : ""
}

/**
 * The branch this worktree takes for an issue: its `> Branch:` line exactly;
 * this branch when it already names the issue; else the issue's branch under
 * this branch's owner prefix.
 */
export function reuseBranch(ticket: Ticket, from: string): string {
  const { branch, exact } = branchFor(ticket)
  if (exact) {
    return branch
  }
  return namesTicket(from, ticket.id) ? from : branchPrefix(from) + branch
}

/**
 * Whether this workspace can take the issue: not when it's closed, missing, or
 * another workspace is already on it. `workspaces` leaves this one out.
 */
export function planReuse(
  ticket: Ticket,
  workspaces: Workspace[],
  from: string,
  options: StartOptions = {},
): Exclude<Start, { action: "start" }> | Reuse {
  const start = planStart(ticket, workspaces, options)
  if (start.action !== "start") {
    return start
  }
  return {
    action: "reuse",
    ticket,
    name: start.name,
    from,
    branch: reuseBranch(ticket, from),
    section: options.byRank ? start.section : options.section,
    addLine: !start.exact,
    move: start.move,
  }
}

/** Untracked work in this workspace: named after its title, on a branch from it. */
export function planRename(
  title: string,
  from: string,
  options: StartOptions = {},
): Reuse {
  const slug = slugify(title, 60)
  if (!slug) {
    throw new UsageError(
      `the title \`${title}\` has no letters or digits to name a branch after`,
    )
  }
  return {
    action: "reuse",
    name: title.trim(),
    from,
    branch: branchPrefix(from) + slug,
    section: options.section,
    addLine: false,
    move: false,
  }
}

export function describeReuse(reuse: Reuse): string {
  const section =
    reuse.section === undefined
      ? "keep"
      : reuse.section === null
        ? "none"
        : `"${reuse.section}"`
  const head = reuse.ticket
    ? `REUSE ${reuse.ticket.id} "${reuse.ticket.title}"`
    : `REUSE "${reuse.name}"`
  const issue = reuse.ticket
    ? ` branch-line=${reuse.addLine ? "add" : "keep"} state=${reuse.move ? "move" : "keep"}`
    : ""
  return `${head} branch=${reuse.from} -> ${reuse.branch} name="${reuse.name}" section=${section}${issue}`
}

/** A value as one single-quoted shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Renames this worktree's branch, refusing when it's pushed (its remote branch
 * and pull request would stay behind under the old name) or the name is taken.
 * `command` is a stacking integration's `rename` op, run with `<name>` filled
 * in so the tool's record of the branch follows it; without one, plain git.
 */
export function renameBranch(
  reuse: Reuse,
  cwd?: string,
  command?: string,
): string {
  const who = reuse.ticket?.id ?? "workspace"
  if (reuse.branch === reuse.from) {
    return `KEPT branch=${reuse.branch}`
  }
  const git = (...args: string[]) => run("git", args, cwd)
  if (
    git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
      .status === 0
  ) {
    return `FAILED ${who} ${reuse.from} is already pushed; renaming it would leave its remote branch and pull request behind`
  }
  if (
    git("show-ref", "--verify", "--quiet", `refs/heads/${reuse.branch}`)
      .status === 0
  ) {
    return `FAILED ${who} a branch named ${reuse.branch} already exists`
  }
  const renamed = command
    ? run(
        "sh",
        ["-c", command.replaceAll("<name>", shellQuote(reuse.branch))],
        cwd,
      )
    : git("branch", "-m", reuse.branch)
  return renamed.status === 0
    ? `RENAMED branch=${reuse.branch}`
    : `FAILED ${who} ${(renamed.stderr || renamed.stdout).trim()}`
}

/** Branches checked out in the repo's git worktrees, as workspaces. */
export function gitWorktrees(porcelain: string): Workspace[] {
  const blocks = porcelain.split("\n\n")
  return blocks.flatMap((block) => {
    const [worktree] = worktreePaths(block)
    const branch = block
      .split("\n")
      .find((line) => line.startsWith("branch refs/heads/"))
      ?.slice("branch refs/heads/".length)
    return worktree && branch
      ? [{ integration: "git", id: worktree, name: worktree, branch }]
      : []
  })
}

function listWorktrees(): Workspace[] {
  const result = run("git", ["worktree", "list", "--porcelain"])
  return result.status === 0 ? gitWorktrees(result.stdout) : []
}

/** The title carries the team's blocker mark (`tickets.blockerMark`). */
export function isBlocker(issue: Assigned, mark?: string): boolean {
  return Boolean(mark && issue.title.includes(mark))
}

/**
 * Tickets with no work started on them yet, in the order to pick them up:
 * most urgent first, then the ones whose title carries the blocker mark
 * (`mark`: they stop a customer), then the earliest due (a deadline is the
 * order within a priority), then the ones blocking other work. One with open
 * sub-issues is left out (they're what gets worked on), and so is one with a
 * pull request or a workspace on its branch.
 */
export function queue(
  issues: Assigned[],
  workspaces: Workspace[],
  mark?: string,
  options: { linked?: boolean } = {},
): Assigned[] {
  const order = (issue: Assigned) =>
    [
      PRIORITIES.indexOf(issue.priority ?? "none"),
      isBlocker(issue, mark) ? 0 : 1,
      issue.dueDate ?? "9999-12-31",
      issue.blocks ? 0 : 1,
    ] as const
  return issues
    .filter(
      (issue) =>
        (options.linked !== false || !issue.link) &&
        !issue.openSubIssues &&
        (issue.pullRequests ?? []).length === 0 &&
        !workspaceOn(
          workspaces,
          issue.id,
          branchFromDescription(issue.description),
        ),
    )
    .sort((a, b) => {
      const [x, y] = [order(a), order(b)]
      return (
        x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]) || x[3] - y[3]
      )
    })
}

/** `--priority urgent,P0` as priorities, by name or by rank name. */
export function parsePriorities(
  value: string,
  ranks: string[] = DEFAULT_RANKS,
): Priority[] {
  const names = value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  return names.map((name) => {
    const found = priorityNamed(name, ranks)
    if (!found) {
      throw new UsageError(
        `unknown priority \`${name}\` (use ${[...new Set([...PRIORITIES, ...ranks])].join(", ")})`,
      )
    }
    return found
  })
}

export function describeTicket(
  issue: Assigned,
  ranks?: string[],
  mark?: string,
): string {
  const state = issue.state ? ` [${issue.state}]` : ""
  const blocker = isBlocker(issue, mark) ? " blocker" : ""
  const blocks = issue.blocks ? " blocks-other-work" : ""
  const filed = issue.createdAt?.slice(0, 10) || "unknown"
  const by = issue.creator ? ` by="${issue.creator}"` : ""
  return `TICKET ${issue.id} "${rankName(issue.priority, ranks)}" due=${issue.dueDate ?? "none"} filed=${filed}${by}${state}${blocker}${blocks} "${issue.title}" ${issue.url}`
}

/**
 * Where an issue's work lands: the repository picked for it and why, or
 * `unsure` with the ones it might be (none when nothing points anywhere).
 */
export type RepositoryPick =
  | {
      repository: Repository
      from: "only" | "named" | "project" | "code"
    }
  | { from: "unsure"; candidates: Repository[] }

/** The names an issue may call a repository by, lowercased. */
function repositoryKeys(repository: Repository): string[] {
  const base = (p?: string | null) =>
    p
      ? (p
          .replace(/[/\\]+$/, "")
          .split(/[/\\]/)
          .pop() ?? "")
      : ""
  const remote = repository.remote?.replace(/\.git$/, "") ?? ""
  const ownerRepo = remote.split("/").slice(-2).join("/")
  return [
    repository.name,
    base(repository.name),
    base(repository.path),
    base(remote),
    ownerRepo.includes("/") ? ownerRepo : "",
  ]
    .map((k) => k.trim().toLowerCase())
    .filter((k, i, all) => k.length >= 3 && all.indexOf(k) === i)
}

/** The text names the key as a word of its own (`noah-server`, not `noah-server-2`). */
function names(text: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`, "i").test(text)
}

/** The text with its links taken out: where they point is no sign of where the work lands. */
function withoutUrls(text: string): string {
  return text.replace(/[a-z][\w+.-]*:\/\/\S+/gi, " ")
}

/** Repo-relative paths the text names (`src/scenarios/bottle.ts`), links left out. */
export function namedPaths(text: string): string[] {
  const found =
    withoutUrls(text).match(/(?<![\w.@/-])[\w.@-]+(?:\/[\w.@-]+)+/g) ?? []
  return [
    ...new Set(
      found
        .map((p) => p.replace(/^\.\//, "").replace(/[.]+$/, ""))
        .filter((p) => /[a-z]/i.test(p)),
    ),
  ]
}

/**
 * The repository an issue's work lands in, from the issue itself: the one
 * repository it names; else the one the config maps its tracker project to
 * (`tickets.repositories`); else the one checkout where the paths it names
 * exist. With one repository there's nothing to pick. Anything else is
 * `unsure`, never this one by default: the person is asked.
 */
export function pickRepository(
  issue: Pick<Assigned, "title" | "description" | "project">,
  repositories: Repository[],
  mapping: Map<string, string> = new Map(),
  exists: (file: string) => boolean = fs.existsSync,
): RepositoryPick {
  if (repositories.length === 1) {
    return { repository: repositories[0], from: "only" }
  }
  const text = withoutUrls(
    `${issue.title}\n${withoutLinkLines(issue.description ?? "")}`,
  )
  const named = repositories.filter((r) =>
    repositoryKeys(r).some((key) => names(text, key)),
  )
  if (named.length === 1) {
    return { repository: named[0], from: "named" }
  }
  const mapped = issue.project
    ? mapping.get(issue.project.trim().toLowerCase())
    : undefined
  const byProject = mapped
    ? repositories.find((r) => repositoryKeys(r).includes(mapped.toLowerCase()))
    : undefined
  if (byProject) {
    return { repository: byProject, from: "project" }
  }
  const paths = namedPaths(text)
  const pool = named.length > 0 ? named : repositories
  const hits = pool
    .filter((r) => r.path)
    .map((r) => ({
      repository: r,
      count: paths.filter((p) => exists(path.join(r.path as string, p))).length,
    }))
    .filter((h) => h.count > 0)
    .sort((a, b) => b.count - a.count)
  if (hits.length === 1 || (hits.length > 1 && hits[0].count > hits[1].count)) {
    return { repository: hits[0].repository, from: "code" }
  }
  return { from: "unsure", candidates: named }
}

/** A pick as the TICKET line's end: `repo="<name>" from=<why> [here]`, or `repo=?`. */
export function describeRepository(pick: RepositoryPick): string {
  if (pick.from === "unsure") {
    const candidates = pick.candidates.map((r) => r.name).join(",")
    return ` repo=?${candidates ? ` candidates="${candidates}"` : ""}`
  }
  const here = pick.repository.current ? " here" : ""
  return ` repo="${pick.repository.name}" from=${pick.from}${here}`
}

const SWITCHES = new Set([
  "no-linked",
  "section-by-rank",
  "no-section",
  "workspaces-repository",
  "yes",
])

type Args = Flags

/** The priorities' names: `--ranks`, else the config's `tickets.ranks`, else the defaults. */
function ranksOf(args: Args): string[] {
  const ranks = args
    .get("ranks")
    ?.split(",")
    .map((r) => r.trim())
  if (!ranks) {
    return readRules(repoRoot()).ranks ?? DEFAULT_RANKS
  }
  const problem = ranksProblem(ranks)
  if (problem) {
    throw new UsageError(`--ranks ${problem}`)
  }
  return ranks
}

/** The section flags, of which at most one is given. */
function placement(args: Args): StartOptions {
  const given = ["section", "section-by-rank", "no-section"].filter((f) =>
    args.has(f),
  )
  if (given.length > 1) {
    throw new UsageError(`pass one of ${given.map((f) => `--${f}`).join(", ")}`)
  }
  return {
    section: args.has("no-section") ? null : args.get("section"),
    byRank: args.has("section-by-rank"),
    ranks: ranksOf(args),
    workspaceName: readRules(repoRoot()).workspaceName,
  }
}

function plan(args: Args): void {
  const file = requiredFlag(args, "input")
  const input = readJson<{ tickets?: Ticket[]; workspaces?: Workspace[] }>(file)
  const options = {
    ...placement(args),
    otherRepository: args.has("workspaces-repository"),
  }
  const workspaces = [...(input.workspaces ?? []), ...listWorktrees()]
  const prompts =
    args.get("prompts") ?? path.join(path.dirname(file), "prompts")
  if (args.has("title")) {
    if (options.byRank || (input.tickets ?? []).length > 0) {
      throw new UsageError(
        "--title takes no tickets in --input and no --section-by-rank",
      )
    }
    const title = requiredFlag(args, "title")
    const start = planUntracked(title, workspaces, options)
    if (start.action !== "start") {
      console.log(describeUntracked(start))
      return
    }
    const notes = args.get("notes")
    const prompt = path.join(prompts, `${start.branch}.md`)
    fs.mkdirSync(prompts, { recursive: true })
    fs.writeFileSync(
      prompt,
      untrackedPrompt(title, notes ? fs.readFileSync(notes, "utf8") : ""),
    )
    console.log(describeUntracked(start, prompt))
    return
  }
  const lines = (input.tickets ?? []).map((ticket) => {
    const start = planStart(ticket, workspaces, options)
    if (start.action !== "start") {
      return describeStart(start)
    }
    const prompt = path.join(prompts, `${start.id}.md`)
    fs.mkdirSync(prompts, { recursive: true })
    fs.writeFileSync(prompt, agentPrompt(start.ticket))
    return describeStart(start, prompt)
  })
  console.log(lines.join("\n"))
}

function reuse(args: Args): void {
  const options = placement(args)
  const from = run("git", ["branch", "--show-current"]).stdout.trim()
  if (!from) {
    throw new UsageError("HEAD is detached: check out this workspace's branch")
  }
  let planned: ReturnType<typeof planReuse>
  if (args.has("title")) {
    if (args.has("input") || options.byRank) {
      throw new UsageError("--title takes no --input or --section-by-rank")
    }
    planned = planRename(requiredFlag(args, "title"), from, options)
  } else {
    const input = readJson<{ tickets?: Ticket[]; workspaces?: Workspace[] }>(
      requiredFlag(args, "input"),
    )
    const tickets = input.tickets ?? []
    if (tickets.length !== 1) {
      throw new UsageError(
        `reuse takes exactly one ticket, got ${tickets.length}`,
      )
    }
    // Every workspace but this one: its own branch is the one checked out here.
    const others = [...(input.workspaces ?? []), ...listWorktrees()].filter(
      (w) => !w.current && w.branch !== from,
    )
    planned = planReuse(tickets[0], others, from, options)
  }
  if (planned.action !== "reuse") {
    console.log(describeStart(planned))
    return
  }
  console.log(describeReuse(planned))
  if (args.has("yes")) {
    const line = renameBranch(planned, undefined, args.get("rename"))
    console.log(line)
    if (line.startsWith("FAILED")) {
      process.exitCode = 1
    }
  }
}

function name(args: Args): void {
  const input = readJson<{ ticket?: Ticket; workspace?: Workspace }>(
    requiredFlag(args, "input"),
  )
  if (!input.ticket?.id || typeof input.workspace?.name !== "string") {
    throw new UsageError(
      'name takes {"ticket": {"id", ...}, "workspace": {"name", "section"}}',
    )
  }
  const template = readRules(repoRoot()).workspaceName ?? DEFAULT_WORKSPACE_NAME
  console.log(
    describeRefresh(
      refreshName(input.ticket, input.workspace, template, ranksOf(args)),
    ),
  )
}

function branchLine(args: Args): void {
  const file = requiredFlag(args, "description")
  const branch = requiredFlag(args, "branch")
  const description = fs.readFileSync(file, "utf8")
  const updated = addBranchLine(description, branch)
  if (updated === description) {
    console.log("UNCHANGED")
    return
  }
  // It's written back whole, so its links go back plain (see links.ts).
  fs.writeFileSync(file, plainDocumentLinks(updated))
  console.log(`ADDED ${file}`)
}

function list(args: Args): void {
  const input = readJson<{
    issues?: Assigned[]
    workspaces?: Workspace[]
    repositories?: Repository[]
  }>(requiredFlag(args, "input"))
  const ranks = ranksOf(args)
  const rules = readRules(repoRoot())
  const all = queue(
    input.issues ?? [],
    [...(input.workspaces ?? []), ...listWorktrees()],
    rules.blockerMark,
    { linked: rules.queueLinked !== false && !args.has("no-linked") },
  )
  const priorities = args.has("priority")
    ? parsePriorities(args.get("priority") as string, ranks)
    : undefined
  const limit = args.has("limit") ? Number(args.get("limit")) : undefined
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new UsageError("--limit takes a whole number above 0")
  }
  const repositories = (input.repositories ?? []).filter(
    (r) => typeof r?.name === "string" && r.name.trim() !== "",
  )
  const mapping = projectRepositories(rules.repositories ?? [])
  const shown = all
    .filter((i) => !priorities || priorities.includes(i.priority ?? "none"))
    .slice(0, limit)
  console.log(
    [
      ...shown.map(
        (issue) =>
          describeTicket(issue, ranks, rules.blockerMark) +
          (repositories.length > 0
            ? describeRepository(pickRepository(issue, repositories, mapping))
            : ""),
      ),
      `COUNT ${shown.length}`,
      `TOTAL ${all.length}`,
    ].join("\n"),
  )
}

/** A lock held longer than this is left by a run that died, and is taken over. */
export const LOCK_STALE_MS = 10 * 60 * 1000

/**
 * Takes the lock at `dir` (a directory, made atomically), waiting up to
 * `waitMs` for whoever holds it. Returns the token that releases it, or
 * undefined when it's still held when the wait runs out.
 */
export function takeLock(
  dir: string,
  waitMs: number,
  options: { staleMs?: number; pollMs?: number; now?: () => number } = {},
): string | undefined {
  const { staleMs = LOCK_STALE_MS, pollMs = 250, now = Date.now } = options
  const until = now() + waitMs
  const token = randomUUID()
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  for (;;) {
    try {
      fs.mkdirSync(dir)
      fs.writeFileSync(path.join(dir, "token"), token)
      return token
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error
      }
    }
    const since = fs.statSync(dir, { throwIfNoEntry: false })?.mtimeMs
    if (since !== undefined && now() - since > staleMs) {
      fs.rmSync(dir, { recursive: true, force: true })
      continue
    }
    if (now() >= until) {
      return undefined
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs)
  }
}

/** Releases the lock at `dir` when `token` holds it. True when it did. */
export function releaseLock(dir: string, token: string): boolean {
  const held = fs.readFileSync(path.join(dir, "token"), "utf8")
  if (held.trim() !== token) {
    return false
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

/** The lock opening workspaces takes, shared by every worktree of the repo. */
function openLock(): string {
  return path.join(stateDir("start-work", { shared: true }), "open.lock")
}

function lock(args: Args): void {
  const wait = Number(args.get("wait") ?? 300)
  if (!(Number.isFinite(wait) && wait >= 0)) {
    throw new UsageError("--wait takes a number of seconds")
  }
  const token = takeLock(openLock(), wait * 1000)
  if (!token) {
    console.log(`BUSY after ${wait}s`)
    process.exitCode = 1
    return
  }
  console.log(`LOCKED ${token}`)
}

function unlock(args: Args): void {
  const token = requiredFlag(args, "token")
  let released = false
  try {
    released = releaseLock(openLock(), token)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  }
  console.log(released ? "UNLOCKED" : "NOT-HELD")
}

const USAGE = `Usage: work.ts <command>

  plan --input <file> [--section <name> | --section-by-rank | --no-section]
       [--workspaces-repository] [--ranks <names>] [--prompts <dir>]
       [--title "<title>" [--notes <file>]]
                  Decide each ticket in <file> ({"tickets": [...], "workspaces":
                  [...]}) against the open workspaces and this repo's git
                  worktrees. Writes nothing to any tracker. Prints one line each:
                    START <ID> "<title>" name="<name>" branch=<branch> exact=<yes|no>
                          section=<"name"|none> state=<move|keep> prompt=<file>
                    EXISTS <ID> workspace="<name>" branch=<branch>
                          branch-line=<add|keep> state=<move|keep>
                    SKIP <ID> <not found|done|canceled>
                  and writes each START's agent prompt to <file>. <name> is
                  the config's tickets.workspaceName filled in (default
                  "{id}: {title}"; also {priority}, {category} (a
                  ticket's "category" in <file>), {id:short} (the id's
                  number), {due} (a ticket's "dueDate"; {due:MM/DD} in
                  a format of YYYY, YY, MMM, MM, M, DD, and D), and
                  {title:N} and {category:N} (cut to N
                  characters, at a word when one ends in reach)). Without a
                  placement flag, a workspace goes in the section of the one
                  this session runs in, or none; with --workspaces-repository (the
                  workspaces open in another repository), in none.
                  With --title, plans one new workspace for work with no
                  ticket (<file> gives only "workspaces"), named <title> on
                  a branch from it, its agent's prompt the title and the
                  notes in --notes:
                    START "<title>" name="<title>" branch=<branch> exact=no
                          section=<"name"|none> state=keep prompt=<file>
                  or EXISTS "<title>" workspace="<name>" branch=<branch>
                  when a workspace is already on that branch.
  reuse (--input <file> | --title "<title>")
        [--section <name> | --section-by-rank | --no-section] [--ranks <names>]
        [--yes [--rename <command>]]
                  Work in this workspace instead of a new one: on the one
                  ticket in <file> (as for plan), or with no ticket on work
                  named <title>. Prints
                    REUSE [<ID> "<title>"|"<title>"] branch=<now> -> <new>
                          name="<name>" section=<"name"|none|keep>
                          [branch-line=<add|keep> state=<move|keep>]
                  or EXISTS (another workspace has the ticket) or SKIP, as
                  for plan. With --yes, it then renames this worktree's
                  branch and prints RENAMED branch=<new>, KEPT branch=<b>
                  when it already fits, or FAILED (exit 1) when the branch
                  is pushed or the new name is taken. --rename renames with
                  <command> (a stacking integration's rename op, its <name>
                  left in) instead of git branch -m.
  name --input <file> [--ranks <names>]
                  The name for the workspace in <file> ({"ticket": {...},
                  "workspace": {"name", "section"}}, the ticket as for
                  plan) now, as sync keeps it in step with its issue:
                    RENAME name="<new>" from="<old>" section=<"name"|keep>
                  when its name follows the config's tickets.workspaceName
                  and the issue's title, priority, category, or due date
                  changed it (section="<rank>" when it sits in another
                  priority's section, as --section-by-rank filed it),
                    KEEP name="<name>"
                  when it already fits, or
                    LEAVE name="<name>" reason="<why>"
                  when someone named it by hand (or the template has no
                  {id} to tell).
  branch-line --description <file> --branch <branch>
                  Add a "> Branch:" line on top of the description in <file>,
                  in place. Prints ADDED <file>, or UNCHANGED when it has one.
  list --input <file> [--priority <names>] [--limit <n>] [--ranks <names>]
       [--no-linked]
                  The tickets in <file> ({"issues": [...], "workspaces": [...],
                  "repositories": [...]}) with no work started yet, in the order to pick them up
                  (by priority, then the config's tickets.blockerMark in the
                  title, then due date, then blocking other work). A ticket
                  marked "link": true (from a read-only tracker) is left out
                  with --no-linked or the config's tickets.queueLinked false:
                    TICKET <ID> "<rank>" due=<date|none>
                           filed=<date|unknown> [by="<name>"] [<state>]
                           [blocker] [blocks-other-work] "<title>" <url>
                           [repo="<name>" from=<why> [here] | repo=?
                            [candidates="<names>"]]
                  then COUNT <n> (printed) and TOTAL <n> (before --priority
                  and --limit). With "repositories" (the workspaces
                  integration's, each {"name", "remote", "path", "current"}),
                  each line ends with the one its work lands in: the one
                  repository it names (from=named), else the one the
                  config's tickets.repositories maps its "project" to
                  (from=project), else the one checkout holding the paths
                  it names (from=code), or the only one (from=only); "here"
                  when that's this one. repo=? when it's unclear, with the
                  repositories it names, if any.
  lock [--wait <seconds>]
                  Take the repo's lock on opening workspaces, shared by all
                  its worktrees, so starts running side by side open one at a
                  time. Waits up to <seconds> (default 300) for whoever holds
                  it, then prints LOCKED <token>, or BUSY (exit 1) when it's
                  still held. A lock older than ${LOCK_STALE_MS / 60000} minutes was left by a run that
                  died, and is taken over.
  unlock --token <token>
                  Release the lock <token> took. Prints UNLOCKED, or NOT-HELD
                  when that token no longer holds it.

--ranks names the priorities ${PRIORITIES.join(", ")}, in that order, for
sections, TICKET lines, and --priority (default: the config's tickets.ranks,
else ${DEFAULT_RANKS.join(", ")}). Exits ${USAGE_EXIT} on bad arguments or input.`

const SUBCOMMANDS: Record<string, (args: Args) => void> = {
  plan,
  reuse,
  name,
  "branch-line": branchLine,
  list,
  lock,
  unlock,
}

export function main(argv: string[]): void {
  runSubcommand(argv, USAGE, SUBCOMMANDS, (rest) => parseFlags(rest, SWITCHES))
}

if (isMain(import.meta.filename)) {
  runMain(() => main(process.argv.slice(2)))
}

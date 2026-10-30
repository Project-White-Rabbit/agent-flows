// The mechanical half of the start-work and tickets-to-work flows: which
// tickets get a workspace, on which branch, with what prompt, and the order
// tickets-to-work goes through them in. Everything vendor-specific (reading
// issues, opening workspaces, moving issues) stays in the skills, which reach
// it through the configured integrations' ops and pass what they read in here
// as a JSON file.
//
// Git worktrees are read here directly: a branch checked out in any worktree
// of the repo already has someone on it, whichever app opened it.

import fs from "node:fs"
import path from "node:path"
import {
  addBranchLine,
  branchFromDescription,
  withoutLinkLines,
} from "../config/branch-line.ts"
import { DEFAULT_RANKS, ranksProblem } from "../config/sections/tickets.ts"
import { worktreePaths } from "../config/sections/worktree.ts"
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
  openSubIssues?: boolean
  pullRequests?: string[]
  blocks?: boolean
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
   * one's, or none in another project, whose sections aren't this one's.
   */
  section?: string | null
  /** The workspaces open in another project (`--project`). */
  otherProject?: boolean
  byRank?: boolean
  ranks?: string[]
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

export function rankName(
  priority: Priority | undefined,
  ranks: string[] = DEFAULT_RANKS,
): string {
  return ranks[PRIORITIES.indexOf(priority ?? "none")] ?? ranks.at(-1) ?? ""
}

function notStarted(ticket: Ticket): boolean {
  return ticket.stage === undefined || ticket.stage === "todo"
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
  const current = workspaces.find((w) => w.current)
  const section = options.byRank
    ? rankName(ticket.priority, options.ranks)
    : options.section !== undefined
      ? options.section
      : options.otherProject
        ? null
        : current?.section?.trim() || null
  return {
    action: "start",
    id: ticket.id,
    ticket,
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
  return `START ${start.id} "${start.ticket.title}" branch=${start.branch} exact=${start.exact ? "yes" : "no"} section=${section} state=${state}${promptPart}`
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
    name: `${ticket.id}: ${ticket.title}`,
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
  return `TICKET ${issue.id} "${rankName(issue.priority, ranks)}" due=${issue.dueDate ?? "none"}${state}${blocker}${blocks} "${issue.title}" ${issue.url}`
}

const SWITCHES = new Set(["section-by-rank", "no-section", "project", "yes"])

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
  }
}

function plan(args: Args): void {
  const file = requiredFlag(args, "input")
  const input = readJson<{ tickets?: Ticket[]; workspaces?: Workspace[] }>(file)
  const options = { ...placement(args), otherProject: args.has("project") }
  const workspaces = [...(input.workspaces ?? []), ...listWorktrees()]
  const prompts =
    args.get("prompts") ?? path.join(path.dirname(file), "prompts")
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

function branchLine(args: Args): void {
  const file = requiredFlag(args, "description")
  const branch = requiredFlag(args, "branch")
  const description = fs.readFileSync(file, "utf8")
  const updated = addBranchLine(description, branch)
  if (updated === description) {
    console.log("UNCHANGED")
    return
  }
  fs.writeFileSync(file, updated)
  console.log(`ADDED ${file}`)
}

function list(args: Args): void {
  const input = readJson<{ issues?: Assigned[]; workspaces?: Workspace[] }>(
    requiredFlag(args, "input"),
  )
  const ranks = ranksOf(args)
  const mark = readRules(repoRoot()).blockerMark
  const all = queue(
    input.issues ?? [],
    [...(input.workspaces ?? []), ...listWorktrees()],
    mark,
  )
  const priorities = args.has("priority")
    ? parsePriorities(args.get("priority") as string, ranks)
    : undefined
  const limit = args.has("limit") ? Number(args.get("limit")) : undefined
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new UsageError("--limit takes a whole number above 0")
  }
  const shown = all
    .filter((i) => !priorities || priorities.includes(i.priority ?? "none"))
    .slice(0, limit)
  console.log(
    [
      ...shown.map((issue) => describeTicket(issue, ranks, mark)),
      `COUNT ${shown.length}`,
      `TOTAL ${all.length}`,
    ].join("\n"),
  )
}

const USAGE = `Usage: work.ts <command>

  plan --input <file> [--section <name> | --section-by-rank | --no-section]
       [--project] [--ranks <names>] [--prompts <dir>]
                  Decide each ticket in <file> ({"tickets": [...], "workspaces":
                  [...]}) against the open workspaces and this repo's git
                  worktrees. Writes nothing to any tracker. Prints one line each:
                    START <ID> "<title>" branch=<branch> exact=<yes|no>
                          section=<"name"|none> state=<move|keep> prompt=<file>
                    EXISTS <ID> workspace="<name>" branch=<branch>
                          branch-line=<add|keep> state=<move|keep>
                    SKIP <ID> <not found|done|canceled>
                  and writes each START's agent prompt to <file>. Without a
                  placement flag, a workspace goes in the section of the one
                  this session runs in, or none; with --project (the
                  workspaces open in another project), in none.
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
  branch-line --description <file> --branch <branch>
                  Add a "> Branch:" line on top of the description in <file>,
                  in place. Prints ADDED <file>, or UNCHANGED when it has one.
  list --input <file> [--priority <names>] [--limit <n>] [--ranks <names>]
                  The tickets in <file> ({"issues": [...], "workspaces": [...]})
                  with no work started yet, in the order to pick them up
                  (by priority, then the config's tickets.blockerMark in the
                  title, then due date, then blocking other work):
                    TICKET <ID> "<rank>" due=<date|none> [<state>] [blocker]
                           [blocks-other-work] "<title>" <url>
                  then COUNT <n> (printed) and TOTAL <n> (before --priority
                  and --limit).

--ranks names the priorities ${PRIORITIES.join(", ")}, in that order, for
sections, TICKET lines, and --priority (default: the config's tickets.ranks,
else ${DEFAULT_RANKS.join(", ")}). Exits ${USAGE_EXIT} on bad arguments or input.`

const SUBCOMMANDS: Record<string, (args: Args) => void> = {
  plan,
  reuse,
  "branch-line": branchLine,
  list,
}

export function main(argv: string[]): void {
  runSubcommand(argv, USAGE, SUBCOMMANDS, (rest) => parseFlags(rest, SWITCHES))
}

if (isMain(import.meta.filename)) {
  runMain(() => main(process.argv.slice(2)))
}

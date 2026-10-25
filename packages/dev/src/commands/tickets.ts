// The mechanical half of the create-tickets flow: the plan's shape, the table
// the person confirms, and the issues apply has filed. Everything
// vendor-specific (searching, filing, linking) stays in the skill, which
// reaches it through the configured issue tracker's ops and writes what it
// learns into the plan.
//
// The plan is a JSON file in the worktree's private git dir. Recording each
// filed issue in it means a re-run after a partial failure updates those
// issues instead of filing them twice.

import fs from "node:fs"
import { isMain, printJson, runMain } from "./lib.ts"

export const PRIORITIES = ["urgent", "high", "medium", "low"] as const

/** The fields an item can set on an issue, in table order. */
const FIELDS = ["priority", "cycle", "dueDate", "assignee", "project"] as const
type Field = (typeof FIELDS)[number]

/** A matched issue as the tracker's `getIssue` op returned it. */
export type Existing = {
  title?: string
  /** The issue is done or canceled. */
  closed?: boolean
  /** In a tracker entry the team only links to, so it can't be updated. */
  readOnly?: boolean
  /** Its parent issue's id. */
  parent?: string | null
} & Partial<Record<Field, string | null>>

export type PlanItem = {
  key: string
  title?: string
  description?: string
  /** The tracker entry to file in, by integration or instance name. */
  tracker?: string
  /** An existing issue's id, or `new`. */
  match?: string
  url?: string
  /** A plan key, or an existing issue's id. */
  parent?: string
  blockedBy?: string[]
  priority?: string
  cycle?: string
  /** `null` clears a matched issue's due date. */
  dueDate?: string | null
  assignee?: string
  project?: string
  label?: string
  estimate?: number | string
  /** Fields set from a default rather than read from the notes. */
  defaults?: string[]
  existing?: Existing
}

export type Plan = {
  source?: { title?: string; url?: string }
  items: PlanItem[]
}

export type Action = "file" | "update" | "unchanged"

export type Row = { row: number; item: PlanItem; action: Action }

export type Checked = {
  problems: string[]
  checks: string[]
  rows: Row[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const CYCLE = /^(current|next|\d+|\d{4}-\d{2}-\d{2})$/

function isNew(item: PlanItem): boolean {
  return item.match === undefined || item.match === "new"
}

function changes(item: PlanItem): Field[] {
  return FIELDS.filter(
    (f) =>
      item[f] !== undefined &&
      String(item[f] ?? "") !== String(item.existing?.[f] ?? ""),
  )
}

export function actionOf(item: PlanItem): Action {
  if (isNew(item)) {
    return "file"
  }
  const relates = (item.blockedBy?.length ?? 0) > 0
  const other = item.label !== undefined || item.estimate !== undefined
  return changes(item).length > 0 || relates || other ? "update" : "unchanged"
}

/**
 * Items in the order apply files them, each parent in the plan before its
 * sub-issues, and the keys whose parent chain loops back on itself.
 */
export function parentsFirst(items: PlanItem[]): {
  ordered: PlanItem[]
  looped: string[]
} {
  const byKey = new Map(items.map((item) => [item.key, item]))
  const ordered: PlanItem[] = []
  const placed = new Set<string>()
  const looped = new Set<string>()
  const place = (item: PlanItem, trail: Set<string>): void => {
    if (placed.has(item.key) || looped.has(item.key)) {
      return
    }
    if (trail.has(item.key)) {
      for (const key of trail) {
        looped.add(key)
      }
      return
    }
    const parent = item.parent ? byKey.get(item.parent) : undefined
    if (parent) {
      place(parent, new Set([...trail, item.key]))
    }
    if (!looped.has(item.key)) {
      ordered.push(item)
      placed.add(item.key)
    }
  }
  for (const item of items) {
    place(item, new Set())
  }
  return { ordered, looped: [...looped].sort() }
}

function shapeProblems(plan: Plan): string[] {
  const problems: string[] = []
  if (!Array.isArray(plan.items) || plan.items.length === 0) {
    return ["the plan has no items"]
  }
  const seen = new Set<string>()
  plan.items.forEach((item, index) => {
    const key = item.key
    if (!key) {
      problems.push(`item ${index + 1}: missing key`)
      return
    }
    if (seen.has(key)) {
      problems.push(`${key}: key used twice`)
    }
    seen.add(key)
    if (isNew(item) && !item.title?.trim()) {
      problems.push(`${key}: a new issue needs a title`)
    }
    if (
      item.priority !== undefined &&
      !PRIORITIES.includes(item.priority as never)
    ) {
      problems.push(`${key}: priority must be one of ${PRIORITIES.join(", ")}`)
    }
    if (
      item.dueDate !== undefined &&
      item.dueDate !== null &&
      !DATE.test(item.dueDate)
    ) {
      problems.push(`${key}: dueDate must be YYYY-MM-DD, or null to clear it`)
    }
    if (item.cycle !== undefined && !CYCLE.test(item.cycle)) {
      problems.push(
        `${key}: cycle must be current, next, a number, or a YYYY-MM-DD date`,
      )
    }
    if (item.parent === key) {
      problems.push(`${key}: an item can't be its own parent`)
    }
    if (item.blockedBy?.includes(key)) {
      problems.push(`${key}: an item can't block itself`)
    }
    // Updates keep an issue where it is; only a new one is filed under a parent.
    if (
      !isNew(item) &&
      item.parent !== undefined &&
      item.parent !== item.existing?.parent
    ) {
      problems.push(
        `${key}: ${item.match} is an existing issue, so it keeps its parent: leave "parent" out`,
      )
    }
    if (!isNew(item) && item.existing?.closed) {
      problems.push(
        `${key}: ${item.match} is closed, so its work is done: drop the item, or set "match": "new" if the notes describe new work`,
      )
    }
    if (!isNew(item) && item.existing?.readOnly) {
      problems.push(
        `${key}: ${item.match} is in a tracker the team only links to, so it can't be updated: drop the item, or set "match": "new"`,
      )
    }
  })
  return problems
}

function dueChecks(item: PlanItem, today: string): string[] {
  const issue = isNew(item) ? item.key : item.match
  if (item.dueDate && item.dueDate < today) {
    return [
      `${issue}: the plan sets it due ${item.dueDate}, before today (${today}): set a later "dueDate"`,
    ]
  }
  const existing = item.existing?.dueDate
  if (
    !isNew(item) &&
    item.dueDate === undefined &&
    existing &&
    existing < today
  ) {
    return [
      `${issue} is due ${existing}, before today (${today}): set a new "dueDate", or null to clear it`,
    ]
  }
  return []
}

export function checkPlan(plan: Plan, today: string): Checked {
  const problems = shapeProblems(plan)
  if (problems.length > 0) {
    return { problems, checks: [], rows: [] }
  }
  const { ordered, looped } = parentsFirst(plan.items)
  if (looped.length > 0) {
    return {
      problems: looped.map(
        (key) => `${key}: parent chain loops back on itself`,
      ),
      checks: [],
      rows: [],
    }
  }
  return {
    problems: [],
    checks: ordered.flatMap((item) => dueChecks(item, today)),
    rows: ordered.map((item, i) => ({
      row: i + 1,
      item,
      action: actionOf(item),
    })),
  }
}

function cell(text: string | undefined | null): string {
  return (text ?? "").replaceAll("|", "/").replaceAll("\n", " ")
}

/** `old → new` for a field the plan changes, the value for one it keeps. */
function fieldCell(item: PlanItem, field: Field): string {
  const planned = item[field]
  const existing = item.existing?.[field]
  let text: string
  if (planned === undefined) {
    text = existing ?? ""
  } else if (isNew(item) || String(planned ?? "") === String(existing ?? "")) {
    text = planned ?? ""
  } else {
    text = `${existing || "none"} → ${planned ?? "none"}`
  }
  return item.defaults?.includes(field) && text ? `${text} (default)` : text
}

export function renderTable(rows: Row[]): string {
  const rowOf = new Map(rows.map((r) => [r.item.key, r]))
  // A plan key reads as the row it's filed in, or as its issue once it has one.
  const ref = (key: string): string => {
    const target = rowOf.get(key)
    if (!target) {
      return key
    }
    return isNew(target.item)
      ? `row ${target.row}`
      : (target.item.match as string)
  }
  const lines = [
    "| # | Action | Issue | Title | Parent | Priority | Cycle | Due | Assignee | Project | Blocked by |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ]
  for (const { row, item, action } of rows) {
    const cells = [
      String(row),
      action,
      isNew(item) ? "new" : (item.match as string),
      cell(item.title ?? item.existing?.title),
      item.parent ? ref(item.parent) : "",
      ...FIELDS.map((f) => cell(fieldCell(item, f))),
      (item.blockedBy ?? []).map(ref).join(", "),
    ]
    lines.push(`| ${cells.join(" | ")} |`)
  }
  return lines.join("\n")
}

export function summaryLine(rows: Row[]): string {
  const count = (action: Action) =>
    rows.filter((r) => r.action === action).length
  return `SUMMARY ${count("file")} to file, ${count("update")} to update, ${count("unchanged")} unchanged`
}

/** Saves a filed issue as the item's match, so a re-run updates it. */
export function recordFiled(
  plan: Plan,
  key: string,
  id: string,
  url?: string,
): Plan {
  const item = plan.items.find((i) => i.key === key)
  if (!item) {
    throw new Error(`the plan has no item \`${key}\``)
  }
  item.match = id
  if (url) {
    item.url = url
  }
  return plan
}

function today(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

type Args = Map<string, string>

function parseArgs(args: string[]): Args {
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("--") || args[i + 1] === undefined) {
      throw new Error(`expected \`--<name> <value>\`, got \`${arg}\``)
    }
    flags.set(arg.slice(2), args[++i])
  }
  return flags
}

function required(args: Args, name: string): string {
  const value = args.get(name)
  if (!value) {
    throw new Error(`--${name} <value> is required`)
  }
  return value
}

function readPlan(file: string): Plan {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Plan
  } catch (error) {
    throw new Error(
      `can't read the plan at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function check(args: Args): void {
  const checked = checkPlan(
    readPlan(required(args, "plan")),
    args.get("today") ?? today(),
  )
  if (checked.problems.length > 0) {
    console.log(checked.problems.map((p) => `PROBLEM ${p}`).join("\n"))
    process.exitCode = 1
    return
  }
  const lines = [renderTable(checked.rows), "", summaryLine(checked.rows)]
  if (checked.checks.length > 0) {
    lines.push("", ...checked.checks.map((c) => `CHECK ${c}`))
  }
  console.log(lines.join("\n"))
}

function record(args: Args): void {
  const file = required(args, "plan")
  const key = required(args, "key")
  const id = required(args, "id")
  const plan = recordFiled(readPlan(file), key, id, args.get("url"))
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`)
  printJson({ recorded: true, key, id })
}

const USAGE = `Usage: tickets.ts <command>

  check --plan <file> [--today YYYY-MM-DD]
                  Check the plan without writing anything. Prints PROBLEM
                  lines and exits 1 when it can't be filed; otherwise the
                  table (rows in the order apply files them, parents first),
                  a SUMMARY line, and CHECK lines that need an answer first.
  record --plan <file> --key <key> --id <id> [--url <url>]
                  Save an issue apply just filed as the item's match, so a
                  re-run updates it instead of filing it again.`

const SUBCOMMANDS: Record<string, (args: Args) => void> = { check, record }

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

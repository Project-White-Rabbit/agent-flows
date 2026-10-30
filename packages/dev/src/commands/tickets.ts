// The mechanical half of the create-tickets flow: the plan's shape, the rules
// the team files by (the config's `tickets` section), the table the person
// confirms, the issues apply has filed, and the planning document's text.
// Everything vendor-specific (searching, filing, linking) stays in the skill,
// which reaches it through the configured issue tracker's ops and writes what
// it learns into the plan.
//
// The plan is a JSON file in the worktree's private git dir. Recording each
// filed issue in it means a re-run after a partial failure updates those
// issues instead of filing them twice.

import fs from "node:fs"
import { getAt } from "../config/config.ts"
import {
  canMatchFor,
  certainMatch,
  type EntryIssues,
  type Ranked,
  rankCandidates,
} from "../config/matching.ts"
import {
  type FiledIssue,
  planningLine,
  planningTitle,
  renderSection,
  sourceKey,
  upsertPlanningLine,
  upsertSection,
} from "../config/planning.ts"
import {
  DEFAULT_RANKS,
  ISSUE_PRIORITIES,
  ranksProblem,
} from "../config/sections/tickets.ts"
import { loadConfig, repoRoot } from "./configure.ts"
import {
  type Flags,
  isMain,
  parseFlags,
  printJson,
  readJson,
  requiredFlag,
  runMain,
  runSubcommand,
  UsageError,
} from "./lib.ts"

/** The tracker's priorities, most urgent first; `none` is a team's lowest rank. */
export const PRIORITIES = ISSUE_PRIORITIES
export type Priority = (typeof PRIORITIES)[number]

/**
 * A priority named on the tracker's scale (`high`) or by the team's rank name
 * for it (`P0`, from `tickets.ranks`), any case; undefined for neither.
 */
export function priorityNamed(
  name: string,
  ranks: string[] = DEFAULT_RANKS,
): Priority | undefined {
  const lower = name.trim().toLowerCase()
  const index = PRIORITIES.indexOf(lower as Priority)
  const rank = ranks.findIndex((r) => r.trim().toLowerCase() === lower)
  return PRIORITIES[index >= 0 ? index : rank]
}

/** A priority as the table shows it: `high (P0)` when the team calls it otherwise. */
export function showPriority(priority: string, ranks?: string[]): string {
  const rank = ranks?.[PRIORITIES.indexOf(priority as Priority)]
  return rank && rank.toLowerCase() !== priority
    ? `${priority} (${rank})`
    : priority
}

/** The fields an item can set on an issue, in table order. */
const FIELDS = ["priority", "cycle", "dueDate", "assignee", "project"] as const
type Field = (typeof FIELDS)[number]

/** An open sub-issue of a matched or referenced issue, as `getIssue` read it. */
export type SubIssue = {
  id: string
  title?: string
  priority?: string | null
  cycle?: string | null
  /** When its cycle starts, `YYYY-MM-DD`. */
  cycleStart?: string | null
  /** When its cycle ends, `YYYY-MM-DD`. */
  cycleEnd?: string | null
  dueDate?: string | null
}

/** A matched issue as the tracker's `getIssue` op returned it. */
export type Existing = {
  title?: string
  url?: string
  /** The issue is done or canceled. */
  closed?: boolean
  /** In a tracker entry the team only links to, so it can't be updated. */
  readOnly?: boolean
  /** Its parent issue's id. */
  parent?: string | null
  /** When its cycle starts, `YYYY-MM-DD`. */
  cycleStart?: string | null
  /** When its cycle ends, `YYYY-MM-DD`. */
  cycleEnd?: string | null
  /** Its open sub-issues. */
  subIssues?: SubIssue[]
} & Partial<Record<Field, string | null>>

/** An issue outside the plan that an item names as its parent or blocker. */
export type Ref = {
  /** `getIssue` found it. */
  found: boolean
  title?: string
  closed?: boolean
  priority?: string | null
  /** Its project's name, or null for none. */
  project?: string | null
  subIssues?: SubIssue[]
}

/** A person the tracker can assign, as its `fieldOptions` op lists them. */
export type Person = { name: string; displayName?: string; email?: string }

/** A cycle (a sprint, an iteration): its number or name, and its dates. */
export type Cycle = {
  id: string
  startsAt: string
  endsAt: string
  current?: boolean
}

/** What the tracker's fields can be set to: its `fieldOptions` op. */
export type TrackerOptions = {
  people?: Person[]
  projects?: string[]
  labels?: string[]
  cycles?: Cycle[]
}

export type PlanItem = {
  key: string
  title?: string
  description?: string
  /** The tracker entry to file in, by integration or instance name. */
  tracker?: string
  /** An existing issue's id, or `new`. */
  match?: string
  url?: string
  /** Set by `record`: apply filed it in this plan's runs. */
  filed?: boolean
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
  /** It stops a customer: the title gets `tickets.blockerMark`. */
  blocker?: boolean
  /** Fields set from a default rather than read from the notes. */
  defaults?: string[]
  existing?: Existing
}

export type Plan = {
  source?: { title?: string; url?: string }
  items: PlanItem[]
  /** Each tracker entry's `fieldOptions`, by entry name; an item without `tracker` uses the first. */
  options?: Record<string, TrackerOptions>
  /** Issues outside the plan that items name as parent or blocker, by id. */
  refs?: Record<string, Ref>
}

/** The config's `tickets` section: how the team files and ranks work. */
export type Rules = {
  dueDateRequired?: string[]
  /** The estimates the team sizes work in, smallest first. */
  estimateScale?: number[]
  parentFollowsSubIssues?: boolean
  blockerMark?: string
  /** The team's names for the priorities, in PRIORITIES order. */
  ranks?: string[]
}

export type Action = "file" | "update" | "unchanged"

/**
 * An item as it will be filed: the plan's item with what the rules derive
 * (a parent's priority and cycle from its sub-issues, the blocker mark).
 */
export type Planned = PlanItem & {
  /** Fields the rules set, not the notes: `priority` and `cycle` from sub-issues. */
  derived?: Field[]
  /** Fields a new sub-issue takes from its parent: `project`. */
  fromParent?: Field[]
  /** The title to set on a matched issue: its own with the blocker mark. */
  retitle?: string
}

export type Row = { row: number; item: Planned; action: Action }

export type Checked = {
  problems: string[]
  checks: string[]
  rows: Row[]
  /** Projects and labels the plan named in part, with the tracker's full name. */
  names?: string[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const CYCLE = /^(current|next|\d+|\d{4}-\d{2}-\d{2})$/

function isNew(item: PlanItem): boolean {
  return item.match === undefined || item.match === "new"
}

/** Lower is more urgent; an unknown or missing priority ranks with `none`. */
function urgency(priority: string | null | undefined): number {
  const index = PRIORITIES.indexOf(priority as never)
  return index >= 0 ? index : PRIORITIES.length - 1
}

function changes(item: PlanItem): Field[] {
  return FIELDS.filter(
    (f) =>
      item[f] !== undefined &&
      String(item[f] ?? "") !== String(item.existing?.[f] ?? ""),
  )
}

function reparents(item: PlanItem): boolean {
  return (
    !isNew(item) &&
    item.parent !== undefined &&
    item.parent !== (item.existing?.parent ?? undefined)
  )
}

export function actionOf(item: Planned): Action {
  if (isNew(item)) {
    return "file"
  }
  const relates = (item.blockedBy?.length ?? 0) > 0
  const other = item.label !== undefined || item.estimate !== undefined
  return changes(item).length > 0 ||
    relates ||
    other ||
    reparents(item) ||
    item.retitle !== undefined
    ? "update"
    : "unchanged"
}

/**
 * Items in the order apply files them, each parent in the plan before its
 * sub-issues, and the keys whose parent chain loops back on itself.
 */
export function parentsFirst<T extends PlanItem>(
  items: T[],
): {
  ordered: T[]
  looped: string[]
} {
  const byKey = new Map(items.map((item) => [item.key, item]))
  const ordered: T[] = []
  const placed = new Set<string>()
  const looped = new Set<string>()
  const place = (item: T, trail: Set<string>): void => {
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

/** The plan with each item's priority on the tracker's scale, where a rank name gave it. */
function onTrackerScale(plan: Plan, ranks?: string[]): Plan {
  if (!Array.isArray(plan.items)) {
    return plan
  }
  return {
    ...plan,
    items: plan.items.map((item) => {
      const priority =
        typeof item.priority === "string"
          ? priorityNamed(item.priority, ranks)
          : undefined
      return priority && priority !== item.priority
        ? { ...item, priority }
        : item
    }),
  }
}

function shapeProblems(plan: Plan, ranks?: string[]): string[] {
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
    if (isNew(item) && !item.title?.trim()) {
      problems.push(`${key}: a new issue needs a title`)
    }
    if (seen.has(key)) {
      problems.push(`${key}: key used twice`)
    }
    seen.add(key)
    if (
      item.priority !== undefined &&
      !PRIORITIES.includes(item.priority as never)
    ) {
      const names = ranks
        ? [...new Set([...PRIORITIES, ...ranks])]
        : [...PRIORITIES]
      problems.push(`${key}: priority must be one of ${names.join(", ")}`)
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
    if (item.parent === key || (!isNew(item) && item.parent === item.match)) {
      problems.push(`${key}: an item can't be its own parent`)
    }
    if (item.blockedBy?.includes(key)) {
      problems.push(`${key}: an item can't block itself`)
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

/** Problems with the issues outside the plan that items name. */
function refProblems(plan: Plan): string[] {
  const keys = new Set(plan.items.map((item) => item.key))
  const problems: string[] = []
  for (const item of plan.items) {
    const named: [string, string][] = [
      ...(item.parent && !keys.has(item.parent) && reparentsOrNew(item)
        ? [["parent", item.parent] as [string, string]]
        : []),
      ...(item.blockedBy ?? [])
        .filter((ref) => !keys.has(ref))
        .map((ref) => ["blocked-by", ref] as [string, string]),
    ]
    for (const [role, ref] of named) {
      const found = plan.refs?.[ref]
      if (!found) {
        problems.push(
          `${item.key}: ${role} ${ref} isn't a plan key, and the plan hasn't loaded it: load it with getIssue and record it in "refs"`,
        )
      } else if (!found.found) {
        problems.push(
          `${item.key}: ${role} ${ref} is neither a plan item nor an issue the tracker has`,
        )
      } else if (found.closed && role === "parent") {
        problems.push(
          `${item.key}: parent ${ref} is closed: file it under an open issue, or leave "parent" out`,
        )
      } else if (found.closed) {
        problems.push(
          `${item.key}: ${ref} is closed, so it blocks nothing: drop it from "blockedBy"`,
        )
      }
    }
  }
  return problems
}

function reparentsOrNew(item: PlanItem): boolean {
  return isNew(item) || reparents(item)
}

/** Lowercase words, for matching a name the notes wrote to the tracker's. */
function normalize(text: string): string {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ")
}

function personMatches(person: Person, wanted: string): boolean {
  const names = [
    person.name,
    person.displayName ?? "",
    (person.email ?? "").split("@")[0] as string,
    person.name.split(" ")[0] as string,
  ]
  return names.some((name) => name && normalize(name) === wanted)
}

/**
 * The tracker's names a plan's project or label can mean: the ones it equals
 * once case and punctuation are dropped, else the ones that contain it.
 */
export function resolveName(value: string, names: string[]): string[] {
  const wanted = normalize(value)
  const exact = names.filter((n) => normalize(n) === wanted)
  if (exact.length > 0 || !wanted) {
    return exact
  }
  return names.filter((n) => normalize(n).includes(wanted))
}

/** The cycle a plan's `cycle` names, from the tracker's current and upcoming ones. */
export function resolveCycle(
  value: string,
  cycles: Cycle[],
): Cycle | undefined {
  const sorted = [...cycles].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt),
  )
  const current = sorted.findIndex((cycle) => cycle.current)
  if (value === "current") {
    return current >= 0 ? sorted[current] : undefined
  }
  if (value === "next") {
    return current >= 0 ? sorted[current + 1] : undefined
  }
  if (DATE.test(value)) {
    return sorted.find(
      (cycle) =>
        cycle.startsAt.slice(0, 10) <= value &&
        value < cycle.endsAt.slice(0, 10),
    )
  }
  return sorted.find((cycle) => cycle.id === value)
}

function optionsFor(plan: Plan, item: PlanItem): TrackerOptions | undefined {
  const options = plan.options ?? {}
  return item.tracker
    ? options[item.tracker]
    : options[Object.keys(options)[0] ?? ""]
}

/** Names the tracker doesn't know: people, projects, labels, and cycles. */
function nameProblems(plan: Plan): string[] {
  const problems: string[] = []
  const list = (names: string[]) => names.join(" | ") || "none"
  for (const item of plan.items) {
    const options = optionsFor(plan, item)
    if (!options) {
      continue
    }
    const { key } = item
    if (item.assignee && options.people) {
      const wanted = normalize(item.assignee)
      const found = options.people.filter((p) => personMatches(p, wanted))
      if (found.length !== 1 && wanted !== "me") {
        problems.push(
          `${key}: assignee "${item.assignee}" matches ${found.length} people (people: ${list(options.people.map((p) => p.name))})`,
        )
      }
    }
    for (const [field, kind, names] of [
      ["project", "project", options.projects],
      ["label", "label", options.labels],
    ] as const) {
      const value = item[field]
      if (value && names) {
        const found = resolveName(value, names)
        if (found.length !== 1) {
          problems.push(
            `${key}: ${kind} "${value}" matches ${found.length} ${kind}s (${kind}s: ${list(names)})`,
          )
        }
      }
    }
    if (item.cycle && options.cycles) {
      if (!resolveCycle(item.cycle, options.cycles)) {
        problems.push(
          `${key}: cycle "${item.cycle}" matches no current or upcoming cycle (cycles: ${list(options.cycles.map((c) => `${c.id} (${c.startsAt.slice(0, 10)})`))})`,
        )
      }
    }
  }
  return problems
}

/**
 * The plan as it will be filed: the rules applied to each item, problems that
 * block filing, checks that need an answer, updates to parents outside the
 * plan that its sub-issues outrank, and the full names of projects and labels
 * it named in part.
 */
function applyRules(
  plan: Plan,
  ordered: PlanItem[],
  rules: Rules,
  today: string,
): { items: Planned[]; problems: string[]; checks: string[]; names: string[] } {
  const problems: string[] = []
  const checks: string[] = []
  const names: string[] = []
  const items: Planned[] = ordered.map((item) => structuredClone(item))
  const byKey = new Map(items.map((item) => [item.key, item]))
  const inPlan = new Set(items.filter((i) => !isNew(i)).map((i) => i.match))
  const priorityOf = (item: Planned) =>
    item.priority ?? item.existing?.priority ?? undefined
  const cycleOf = (item: Planned) =>
    item.cycle ?? item.existing?.cycle ?? undefined
  const startOf = (item: Planned): string | undefined => {
    const cycle = cycleOf(item)
    if (!cycle) {
      return undefined
    }
    const cycles = optionsFor(plan, item)?.cycles
    const found = cycles ? resolveCycle(cycle, cycles) : undefined
    if (found) {
      return found.startsAt.slice(0, 10)
    }
    return item.cycle === undefined
      ? (item.existing?.cycleStart ?? undefined)
      : undefined
  }
  const endOf = (item: Planned): string | undefined => {
    const cycle = cycleOf(item)
    const cycles = optionsFor(plan, item)?.cycles
    const found = cycle && cycles ? resolveCycle(cycle, cycles) : undefined
    if (found) {
      return found.endsAt.slice(0, 10)
    }
    return item.cycle === undefined
      ? (item.existing?.cycleEnd ?? undefined)
      : undefined
  }
  // A cycle that hasn't ended: by its end date, else by being among the
  // current and upcoming cycles the tracker listed.
  const unended = (owner: Planned, cycle: string, end?: string | null) => {
    if (end) {
      return end.slice(0, 10) > today
    }
    const cycles = optionsFor(plan, owner)?.cycles
    return !cycles || resolveCycle(cycle, cycles) !== undefined
  }
  // A plan item's sub-issues: items filed under it, and its open sub-issues
  // the plan doesn't touch.
  const children = (item: Planned) => {
    const id = isNew(item) ? undefined : item.match
    return {
      planned: items.filter(
        (child) =>
          child !== item &&
          (child.parent === item.key ||
            (id !== undefined &&
              (child.parent ?? child.existing?.parent) === id)),
      ),
      open: (item.existing?.subIssues ?? []).filter(
        (sub) => !inPlan.has(sub.id),
      ),
    }
  }

  for (const item of items) {
    const options = optionsFor(plan, item)
    for (const [field, known] of [
      ["project", options?.projects],
      ["label", options?.labels],
    ] as const) {
      const value = item[field]
      const [full, ...more] = value && known ? resolveName(value, known) : []
      if (full && more.length === 0 && full !== value) {
        item[field] = full
        names.push(`${item.key}: ${field} "${value}" is "${full}"`)
      }
    }
  }

  // Parents first, so a sub-issue of a new sub-issue takes the project its
  // parent just took.
  for (const item of items) {
    if (!isNew(item) || !item.parent) {
      continue
    }
    if (item.project !== undefined && !item.defaults?.includes("project")) {
      continue
    }
    const parent = byKey.get(item.parent)
    const project = parent
      ? (parent.project ?? parent.existing?.project)
      : plan.refs?.[item.parent]?.project
    if (project) {
      item.project = project
      item.defaults = item.defaults?.filter((f) => f !== "project")
      item.fromParent = [...(item.fromParent ?? []), "project"]
    }
  }

  const mark = rules.blockerMark
  for (const item of items) {
    if (!item.blocker) {
      continue
    }
    if (!mark) {
      problems.push(
        `${item.key}: "blocker" needs tickets.blockerMark in the config, the mark its title gets: set it, or leave "blocker" out`,
      )
    } else if (isNew(item) && item.title && !item.title.includes(mark)) {
      item.title = `${mark} ${item.title.trim()}`
    } else if (
      !isNew(item) &&
      item.existing?.title &&
      !item.existing.title.includes(mark)
    ) {
      item.retitle = `${mark} ${item.existing.title.trim()}`
    }
  }

  // Sub-issues before parents, so a nested parent sees its children's result.
  const updates = new Map<string, Planned>()
  if (rules.parentFollowsSubIssues) {
    const forced: string[] = []
    for (const item of [...items].reverse()) {
      const { planned, open } = children(item)
      const kids = [
        ...planned.map((c) => ({
          id: isNew(c) ? c.key : (c.match as string),
          priority: priorityOf(c),
          cycle: cycleOf(c),
          start: startOf(c),
          end: endOf(c),
        })),
        ...open.map((s) => ({
          id: s.id,
          priority: s.priority ?? undefined,
          cycle: s.cycle ?? undefined,
          start: s.cycleStart ?? undefined,
          end: s.cycleEnd ?? undefined,
        })),
      ]
      if (kids.length === 0) {
        continue
      }
      const top = Math.min(...kids.map((k) => urgency(k.priority)))
      const own = priorityOf(item)
      if (top < urgency(own)) {
        const forcing = kids.filter((k) => urgency(k.priority) === top)
        if (
          item.priority !== undefined &&
          !item.defaults?.includes("priority")
        ) {
          forced.unshift(
            `${isNew(item) ? item.key : item.match}: the plan sets ${item.priority}, but open sub-issues ${forcing.map((k) => `${k.id} (${k.priority})`).join(", ")} force it to ${PRIORITIES[top]}: lower those (add each to the plan with "match" and "priority"), or keep ${PRIORITIES[top]} on purpose`,
          )
        }
        item.priority = PRIORITIES[top]
        item.derived = [...(item.derived ?? []), "priority"]
      }
      const ownCycle =
        item.cycle !== undefined && !item.defaults?.includes("cycle")
          ? item.cycle
          : (item.existing?.cycle ?? undefined)
      const dated = kids.filter(
        (k) => k.cycle && k.start && unended(item, k.cycle, k.end),
      )
      if (!ownCycle && dated.length > 0) {
        const earliest = dated.reduce((a, b) =>
          (a.start as string) <= (b.start as string) ? a : b,
        )
        item.cycle = earliest.cycle
        item.derived = [...(item.derived ?? []), "cycle"]
      }
    }
    checks.push(...forced)
    // A parent outside the plan that a sub-issue outranks moves up too: one
    // filed or moved under it, or one already there that the plan raises.
    for (const item of items) {
      const id =
        item.parent ?? (isNew(item) ? undefined : item.existing?.parent)
      if (!id || byKey.has(id) || inPlan.has(id)) {
        continue
      }
      const ref = plan.refs?.[id]
      if (!ref) {
        const raised =
          item.priority !== undefined &&
          urgency(item.priority) < urgency(item.existing?.priority)
        if (raised) {
          problems.push(
            `${item.key}: the plan raises ${item.match}, which may move its parent ${id} up (tickets.parentFollowsSubIssues), and the plan hasn't loaded it: load it with getIssue and record it in "refs"`,
          )
        }
        continue
      }
      if (!ref.found) {
        continue
      }
      const wanted = Math.min(
        urgency(priorityOf(item)),
        urgency(updates.get(id)?.priority),
        ...(ref.subIssues ?? [])
          .filter((s) => !inPlan.has(s.id))
          .map((s) => urgency(s.priority)),
      )
      if (wanted < urgency(ref.priority)) {
        updates.set(id, {
          key: id,
          match: id,
          priority: PRIORITIES[wanted],
          derived: ["priority"],
          existing: { title: ref.title, priority: ref.priority ?? null },
        })
      }
    }
  }

  for (const item of items) {
    const due =
      item.dueDate !== undefined ? item.dueDate : item.existing?.dueDate
    const priority = priorityOf(item)
    const { planned, open } = children(item)
    const isParent = planned.length + open.length > 0
    if (
      priority &&
      rules.dueDateRequired?.includes(priority) &&
      !due &&
      !isParent
    ) {
      problems.push(
        `${item.key}: every ${showPriority(priority, rules.ranks)} issue needs a due date (tickets.dueDateRequired): set "dueDate", or ask for one`,
      )
    }
    if (
      rules.estimateScale &&
      item.estimate !== undefined &&
      !rules.estimateScale.includes(Number(item.estimate))
    ) {
      problems.push(
        `${item.key}: estimate ${item.estimate} isn't on the team's scale (tickets.estimateScale: ${rules.estimateScale.join(", ")}): pick one of those`,
      )
    }
    const start = startOf(item)
    if (due && start && due < start) {
      problems.push(
        `${item.key}: due ${due} is before its cycle ${cycleOf(item)} starts (${start}): move the date or the cycle`,
      )
    }
  }

  for (const item of items) {
    checks.push(...dueChecks(item, today))
    if (isNew(item)) {
      continue
    }
    for (const sub of children(item).open) {
      if (sub.dueDate && sub.dueDate < today) {
        checks.push(
          `${sub.id}, a sub-issue of ${item.match}, is due ${sub.dueDate}, before today (${today}): add it to the plan with "match": "${sub.id}" and a new "dueDate", or null to clear it`,
        )
      }
    }
    if (item.existing?.project === null && item.project === undefined) {
      checks.push(
        `${item.match} has no project and the notes name none: set "project"`,
      )
    }
  }
  return { items: [...items, ...updates.values()], problems, checks, names }
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

export function checkPlan(
  plan: Plan,
  today: string,
  rules: Rules = {},
): Checked {
  plan = onTrackerScale(plan, rules.ranks)
  const shape = shapeProblems(plan, rules.ranks)
  if (shape.length > 0) {
    return { problems: shape, checks: [], rows: [] }
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
  const named = [...refProblems(plan), ...nameProblems(plan)]
  if (named.length > 0) {
    return { problems: named, checks: [], rows: [] }
  }
  const { items, problems, checks, names } = applyRules(
    plan,
    ordered,
    rules,
    today,
  )
  if (problems.length > 0) {
    return { problems, checks: [], rows: [] }
  }
  return {
    problems: [],
    checks,
    names,
    rows: items.map((item, i) => ({
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
function fieldCell(
  item: Planned,
  field: Field,
  show: (value: string) => string = (value) => value,
): string {
  const shown = (value: string | null | undefined) => value && show(value)
  const planned = shown(item[field])
  const existing = shown(item.existing?.[field])
  let text: string
  if (planned === undefined) {
    text = existing ?? ""
  } else if (isNew(item) || String(planned ?? "") === String(existing ?? "")) {
    text = planned ?? ""
  } else {
    text = `${existing || "none"} → ${planned ?? "none"}`
  }
  if (text && item.derived?.includes(field)) {
    return `${text} (sub-issues)`
  }
  if (text && item.fromParent?.includes(field)) {
    return `${text} (parent)`
  }
  return item.defaults?.includes(field) && text ? `${text} (default)` : text
}

export function renderTable(rows: Row[], ranks?: string[]): string {
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
  const parentCell = (item: Planned): string => {
    if (!reparents(item)) {
      return item.parent ? ref(item.parent) : (item.existing?.parent ?? "")
    }
    return `${item.existing?.parent || "none"} → ${ref(item.parent as string)}`
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
      cell(item.retitle ?? item.title ?? item.existing?.title),
      parentCell(item),
      ...FIELDS.map((f) =>
        cell(
          fieldCell(
            item,
            f,
            f === "priority" ? (p) => showPriority(p, ranks) : undefined,
          ),
        ),
      ),
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

/** The issues a plan filed, updated, or matched, each once. */
export function planIds(plan: Plan): string[] {
  const ids = plan.items
    .filter((item) => !isNew(item))
    .map((item) => item.match as string)
  return [...new Set(ids)]
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
  item.filed = true
  if (url) {
    item.url = url
  }
  return plan
}

/** The plan's issues as the planning document lists them, once each is filed or matched. */
export function filedIssues(plan: Plan): FiledIssue[] {
  return plan.items
    .filter((item) => !isNew(item))
    .map((item) => ({
      id: item.match as string,
      title: item.existing?.title ?? item.title ?? "",
      url: item.url ?? item.existing?.url,
      action: item.filed
        ? "filed"
        : actionOf(item) === "update"
          ? "updated"
          : "unchanged",
    }))
}

const MAX_CANDIDATES = 5
const MAX_LINKED_CANDIDATES = 3

function candidateLine(c: Ranked): string {
  const flags = [
    c.exact ? "exact title" : "",
    c.searchRank ? `search #${c.searchRank}` : "",
    c.sameSource ? "same notes" : "",
    c.issue.open === false ? "closed" : "",
  ].filter(Boolean)
  const head = [c.score.toFixed(2), ...flags].join(", ")
  const parent = c.issue.parent ? ` parent=${c.issue.parent}` : ""
  const prs = (c.issue.pullRequests ?? []).length
  return `  CANDIDATE ${head} ${issueText(c)}${parent}${prs > 0 ? ` prs=${prs}` : ""}`
}

function issueText(c: Ranked): string {
  const state = c.issue.state ? ` [${c.issue.state}]` : ""
  const url = c.issue.url ? ` ${c.issue.url}` : ""
  return `${c.issue.identifier} "${cell(c.issue.title)}"${state}${url} (${c.entry})`
}

/**
 * Ranks every entry's issues against each item, and sets `match` on an item
 * that has none when one is certain (the same title, or filed from the same
 * notes) and no other item claims it. Returns the lines to judge the rest by.
 */
export function matchPlan(
  plan: Plan,
  entries: Record<string, EntryIssues>,
  options: { key?: string; mark?: string; branch?: string } = {},
): string[] {
  const canMatch = canMatchFor(entries, options.branch)
  const ranked = new Map<string, Ranked[]>()
  for (const item of plan.items) {
    ranked.set(
      item.key,
      Object.entries(entries)
        .flatMap(([entry, found]) =>
          rankCandidates(item, entry, found.issues, {
            key: options.key,
            mark: options.mark,
            hits: found.hits?.[item.key],
          }),
        )
        .sort(
          (a, b) =>
            Number(b.exact) - Number(a.exact) ||
            b.fused - a.fused ||
            b.score - a.score,
        ),
    )
  }
  const proposals = new Map<string, Ranked>()
  for (const item of plan.items) {
    if (item.match !== undefined) {
      continue
    }
    const chosen = certainMatch(ranked.get(item.key) ?? [], canMatch)
    if (chosen) {
      proposals.set(item.key, chosen)
    }
  }
  const claimed = [
    ...[...proposals.values()].map((c) => c.issue.identifier),
    ...plan.items.filter((i) => !isNew(i)).map((i) => i.match as string),
  ]
  const why = new Map<string, Ranked>()
  for (const [key, chosen] of proposals) {
    const id = chosen.issue.identifier
    if (claimed.filter((c) => c === id).length === 1) {
      const item = plan.items.find((i) => i.key === key) as PlanItem
      item.match = id
      why.set(key, chosen)
    }
  }
  // Only issues an item now holds; one two items wanted stays a candidate.
  const taken = new Set(
    plan.items.filter((i) => !isNew(i)).map((i) => i.match as string),
  )
  const lines: string[] = []
  for (const item of plan.items) {
    lines.push(`ITEM ${item.key} "${cell(item.title)}"`)
    const all = ranked.get(item.key) ?? []
    const auto = why.get(item.key)
    if (auto) {
      lines.push(
        `  MATCH ${auto.exact ? "exact title" : "same notes"} ${issueText(auto)}`,
      )
    } else if (item.match === "new") {
      lines.push("  NEW (forced)")
    } else if (item.match !== undefined) {
      lines.push(`  MATCH set before ${item.match}`)
    }
    const others = all.filter((c) => !taken.has(c.issue.identifier))
    const shown = [
      ...others.filter((c) => !entries[c.entry]?.link).slice(0, MAX_CANDIDATES),
      ...others
        .filter((c) => entries[c.entry]?.link)
        .slice(0, MAX_LINKED_CANDIDATES),
    ]
    lines.push(...shown.map(candidateLine))
    if (item.match === undefined && shown.length === 0) {
      lines.push("  NEW")
    }
  }
  return lines
}

/** The current cycle's start, from the first tracker entry's options. */
function currentCycleStart(plan: Plan): string | undefined {
  const first = Object.values(plan.options ?? {})[0]
  return first?.cycles?.find((cycle) => cycle.current)?.startsAt
}

function today(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The config's `tickets` section, from the repo this runs in. */
export function readRules(root: string): Rules {
  const config = loadConfig(root).config
  const section = config ? getAt(config, "tickets") : undefined
  if (!section || typeof section !== "object") {
    return {}
  }
  const s = section as Record<string, unknown>
  return {
    ...(Array.isArray(s.dueDateRequired)
      ? { dueDateRequired: s.dueDateRequired as string[] }
      : {}),
    ...(Array.isArray(s.estimateScale)
      ? { estimateScale: s.estimateScale as number[] }
      : {}),
    ...(s.parentFollowsSubIssues === true
      ? { parentFollowsSubIssues: true }
      : {}),
    ...(typeof s.blockerMark === "string"
      ? { blockerMark: s.blockerMark }
      : {}),
    ...(Array.isArray(s.ranks) && !ranksProblem(s.ranks as string[])
      ? { ranks: s.ranks as string[] }
      : {}),
  }
}

type Args = Flags

function readPlan(file: string): Plan {
  return readJson<Plan>(file)
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8")
  } catch (error) {
    throw new UsageError(
      `can't read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function check(args: Args): void {
  const rules = readRules(repoRoot())
  const checked = checkPlan(
    readPlan(requiredFlag(args, "plan")),
    args.get("today") ?? today(),
    rules,
  )
  if (checked.problems.length > 0) {
    console.log(checked.problems.map((p) => `PROBLEM ${p}`).join("\n"))
    process.exitCode = 1
    return
  }
  const lines = [
    renderTable(checked.rows, rules.ranks),
    "",
    summaryLine(checked.rows),
  ]
  if (checked.names?.length) {
    lines.push("", ...checked.names.map((n) => `NAME ${n}`))
  }
  if (checked.checks.length > 0) {
    lines.push("", ...checked.checks.map((c) => `CHECK ${c}`))
  }
  console.log(lines.join("\n"))
}

function record(args: Args): void {
  const file = requiredFlag(args, "plan")
  const key = requiredFlag(args, "key")
  const id = requiredFlag(args, "id")
  const plan = recordFiled(readPlan(file), key, id, args.get("url"))
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`)
  printJson({ recorded: true, key, id })
}

function ids(args: Args): void {
  const found = planIds(readPlan(requiredFlag(args, "plan")))
  console.log(found.length > 0 ? found.join(" ") : "NONE")
}

function notes(args: Args): void {
  const plan = readPlan(requiredFlag(args, "plan"))
  const text = readText(requiredFlag(args, "notes"))
  const day = args.get("today") ?? today()
  const source = plan.source ?? {}
  const key = sourceKey(source, text)
  const section = renderSection(day, source, key, text, filedIssues(plan))
  const out = args.get("out")
  if (out) {
    fs.writeFileSync(out, `${section}\n`)
  }
  const document = args.get("document")
  printJson({
    title: planningTitle(currentCycleStart(plan), day),
    key,
    ...(out ? { section: out } : { section }),
    ...(document
      ? { content: upsertSection(readText(document), key, section) }
      : {}),
  })
}

function match(args: Args): void {
  const file = requiredFlag(args, "plan")
  const plan = readPlan(file)
  const entries = readJson<Record<string, EntryIssues>>(
    requiredFlag(args, "issues"),
  )
  const notesFile = args.get("notes")
  const notesText = notesFile ? readText(notesFile) : ""
  const source = plan.source ?? {}
  // Pasted notes are known by their text; with neither, nothing was filed from them.
  const key =
    source.url?.trim() || notesText.trim()
      ? sourceKey(source, notesText)
      : undefined
  const lines = matchPlan(plan, entries, {
    key,
    mark: readRules(repoRoot()).blockerMark,
    branch: args.get("branch"),
  })
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`)
  console.log(lines.join("\n"))
}

function planning(args: Args): void {
  const plan = readPlan(requiredFlag(args, "plan"))
  const file = requiredFlag(args, "description")
  const text = readText(requiredFlag(args, "notes"))
  const source = plan.source ?? {}
  const line = planningLine(
    requiredFlag(args, "title"),
    requiredFlag(args, "url"),
    source,
    sourceKey(source, text),
  )
  const before = readText(file)
  const after = upsertPlanningLine(before, line)
  fs.writeFileSync(file, after)
  console.log(before.trim() === after.trim() ? "UNCHANGED" : "CHANGED")
}

const USAGE = `Usage: tickets.ts <command>

  check --plan <file> [--today YYYY-MM-DD]
                  Check the plan, by the config's \`tickets\` rules, without
                  writing anything. Prints PROBLEM lines and exits 1 when it
                  can't be filed; otherwise the table (rows in the order apply
                  files them, parents first, then parents outside the plan its
                  sub-issues move up), a SUMMARY line, NAME lines for each
                  project or label the plan named in part (with the tracker's
                  full name), and CHECK lines that need an answer first.
  match --plan <file> --issues <file> [--notes <file>] [--branch <branch>]
                  Rank each entry's issues (--issues: {"<entry>": {"link",
                  "issues", "hits": {"<key>": [<id>...]}}}) against each item
                  by shared words and the search's own rank, and set "match"
                  on an item that has none when it's certain: the only open
                  issue with the same title, or one filed from the same notes.
                  Prints ITEM, MATCH, CANDIDATE, and NEW lines.
  record --plan <file> --key <key> --id <id> [--url <url>]
                  Save an issue apply just filed as the item's match, so a
                  re-run updates it instead of filing it again.
  ids --plan <file>
                  The issues the plan filed, updated, or matched, each once,
                  space-separated, or NONE.
  notes --plan <file> --notes <file> [--out <file>] [--document <file>] [--today YYYY-MM-DD]
                  The planning document's title and this run's section (the
                  notes as written, and the plan's issues), as JSON with the
                  source key that finds the section again. --out writes the
                  section to a file; --document, the document's current text,
                  adds \`content\`: the document with the section in place.
  planning-line --plan <file> --notes <file> --description <file> --title <doc title> --url <doc url>
                  Put the \`> Planning:\` line linking the document into the
                  description file, replacing one it has. Prints CHANGED or
                  UNCHANGED.

Exits 2 on bad arguments or a plan it can't read.`

const SUBCOMMANDS: Record<string, (args: Args) => void> = {
  check,
  match,
  record,
  ids,
  notes,
  "planning-line": planning,
}

export function main(argv: string[]): void {
  runSubcommand(argv, USAGE, SUBCOMMANDS, (rest) => parseFlags(rest))
}

if (isMain(import.meta.filename)) {
  runMain(() => main(process.argv.slice(2)))
}

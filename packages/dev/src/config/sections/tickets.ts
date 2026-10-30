import type {
  DetectContext,
  Detection,
  FieldPattern,
  FieldValue,
  SectionSpec,
} from "../types.ts"

/** The priorities on the issue tracker's scale, most urgent first. */
export const ISSUE_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const

/** What each priority is called, in ISSUE_PRIORITIES order, unless `ranks` says. */
export const DEFAULT_RANKS = ["Urgent", "High", "Medium", "Low", "No priority"]

/**
 * What's wrong with a list of rank names, or undefined: one per priority, no
 * two alike, and a priority's own name (`high`) only in its own place, so a
 * name always reads back as the same priority.
 */
export function ranksProblem(ranks: string[]): string | undefined {
  if (ranks.length !== ISSUE_PRIORITIES.length) {
    return `must name ${ISSUE_PRIORITIES.length} ranks, one each for ${ISSUE_PRIORITIES.join(", ")} (got ${ranks.length})`
  }
  const lower = ranks.map((r) => r.trim().toLowerCase())
  const twice = lower.find((r, i) => lower.indexOf(r) !== i)
  if (twice !== undefined) {
    return `names \`${twice}\` twice`
  }
  const misplaced = lower.findIndex(
    (r, i) =>
      ISSUE_PRIORITIES.includes(r as never) && ISSUE_PRIORITIES[i] !== r,
  )
  return misplaced >= 0
    ? `names the \`${ISSUE_PRIORITIES[misplaced]}\` rank \`${ranks[misplaced]}\`, another priority's name`
    : undefined
}

/** A tracker's name for a priority (`High (2)`, `Highest`, `No priority`), on its scale. */
function trackerPriority(
  text: string,
): (typeof ISSUE_PRIORITIES)[number] | undefined {
  const t = text.toLowerCase()
  if (/\b(no priority|none|lowest)\b/.test(t)) {
    return "none"
  }
  if (/\b(urgent|highest)\b/.test(t)) {
    return "urgent"
  }
  return (["high", "medium", "low"] as const).find((p) =>
    new RegExp(`\\b${p}\\b`).test(t),
  )
}

/** A markdown table's rows, each as its cells, header first. */
function tables(text: string): string[][][] {
  const found: string[][][] = []
  let rows: string[][] = []
  for (const line of [...text.split("\n"), ""]) {
    const row = line.trim()
    if (row.startsWith("|")) {
      if (!/^\|[\s|:-]+\|$/.test(row)) {
        rows.push(
          row
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim().replaceAll(/\*\*|`/g, "")),
        )
      }
      continue
    }
    if (rows.length > 1) {
      found.push(rows)
    }
    rows = []
  }
  return found
}

/**
 * The repo's rank names, from a prioritization doc's table: one row per rank,
 * its name in the first column and the tracker priority it maps to in another
 * (`| P0 | … | High (2) |`), every priority once. Undefined when no table does.
 */
export function ranksFromDoc(text: string): string[] | undefined {
  for (const [, ...body] of tables(text)) {
    const width = Math.min(...body.map((r) => r.length))
    for (let column = 1; column < width; column++) {
      const ranks: string[] = []
      for (const row of body) {
        const priority = trackerPriority(row[column])
        const index = priority ? ISSUE_PRIORITIES.indexOf(priority) : -1
        if (index < 0 || ranks[index] !== undefined || !row[0]) {
          break
        }
        ranks[index] = row[0]
      }
      if (
        body.length === ISSUE_PRIORITIES.length &&
        ranks.filter(Boolean).length === ISSUE_PRIORITIES.length &&
        !ranksProblem(ranks)
      ) {
        return ranks
      }
    }
  }
  return undefined
}

/** A tracked doc about how the team prioritizes (`TASK_PRIORITIZATION.md`). */
const PRIORITIZATION_DOC = /(^|\/)[^/]*priorit[^/]*\.mdx?$/i

function detectTickets(ctx: DetectContext): Detection | undefined {
  for (const file of ctx.tracked.filter((f) => PRIORITIZATION_DOC.test(f))) {
    const ranks = ranksFromDoc(ctx.read(file) ?? "")
    if (
      ranks?.some((r, i) => r.toLowerCase() !== DEFAULT_RANKS[i].toLowerCase())
    ) {
      return {
        values: { ranks },
        evidence: [
          `${file} ranks work as ${ranks.join(", ")}, mapped to the tracker's ${ISSUE_PRIORITIES.join(", ")}`,
        ],
      }
    }
  }
  return undefined
}

const PRIORITY: FieldPattern = {
  regex: /^(urgent|high|medium|low|none)$/,
  hint: "`urgent`, `high`, `medium`, `low`, or `none`",
}

const MARK: FieldPattern = {
  regex: /^\S{1,4}$/,
  hint: "a short mark with no spaces, such as an emoji (`🛑`)",
}

export const tickets: SectionSpec = {
  path: "tickets",
  name: "Ticket rules",
  purpose:
    "How the team files and ranks issues, beyond what any one tracker holds: the planning document, the blocker mark, and the rules create-tickets checks before filing",
  fields: [
    {
      key: "planningDoc",
      type: "boolean",
      description:
        "Record each create-tickets run's notes, and the issues filed from them, in the planning document of the cycle they're filed in, and link each issue back to it with a `> Planning:` line",
      example: true,
    },
    {
      key: "blockerMark",
      description:
        "Mark at the start of the title of an issue that stops a customer: create-tickets adds it to an item marked `blocker`, sync keeps it when it retitles, and tickets-to-work takes marked issues first within each priority",
      example: "🛑",
      pattern: MARK,
    },
    {
      key: "dueDateRequired",
      type: "string[]",
      description:
        "Priorities (`urgent`, `high`, `medium`, `low`, `none`, on the tracker's scale) whose issues must have a due date: create-tickets won't file one without it, unless the issue is a parent whose sub-issues carry the dates, and sync asks for one when it files or ranks the branch's issue at one of them",
      example: ["high"],
      pattern: PRIORITY,
    },
    {
      key: "ranks",
      type: "string[]",
      description:
        "The team's names for the tracker's priorities, one each for `urgent`, `high`, `medium`, `low`, and `none`, in that order (default `Urgent`, `High`, `Medium`, `Low`, `No priority`): start-work's `--section-by-rank` names sections after them, tickets-to-work shows them and takes them in `--priority`, and create-tickets takes them as an item's priority and shows them beside it",
      example: ["Urgent", "P0", "P1", "P2", "Audit"],
      check: (value: FieldValue) => ranksProblem(value as string[]),
    },
    {
      key: "estimateScale",
      type: "number[]",
      description:
        "The estimates the team sizes work in, smallest first: sync and create-tickets estimate on it, and create-tickets refuses an estimate off it",
      example: [1, 2, 4, 8],
    },
    {
      key: "parentFollowsSubIssues",
      type: "boolean",
      description:
        "A parent issue takes the priority of its most urgent open sub-issue, and, when it has no cycle, the cycle of its earliest one",
      example: true,
    },
  ],
  lookup:
    "Leave it out unless the repo's agent instructions say how the team ranks and files work: a planning document per cycle, a mark for customer blockers, due dates required at some priorities, its own names for the priorities (P0, P1, …, read off the doc that maps them to the tracker's), parents ranked by their sub-issues, the estimates the team sizes work in",
  detect: detectTickets,
}

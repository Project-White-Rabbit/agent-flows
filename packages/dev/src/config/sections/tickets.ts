import type { FieldPattern, SectionSpec } from "../types.ts"

/** The priorities on the issue tracker's scale, most urgent first. */
export const ISSUE_PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
] as const

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
    "Leave it out unless the repo's agent instructions say how the team ranks and files work: a planning document per cycle, a mark for customer blockers, due dates required at some priorities, parents ranked by their sub-issues, the estimates the team sizes work in",
}

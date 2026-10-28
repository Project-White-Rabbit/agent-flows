import type { Flow } from "@agent-flows/core"
import {
  CONFIGURE_INTEGRATIONS,
  DEV_COMMANDS,
  devKit,
  flowDir,
  HOOKS_COMMAND,
  hooksInvariant,
  REQUIRE_CONFIG,
  UNKNOWN_FLAGS,
  USE_INTEGRATIONS,
} from "./kit.ts"
import { RANKS, STAGES } from "./start-work.ts"

const INPUT_EXAMPLE = `{
  "issues": [
    { "id": "<ID>", "title": "...", "url": "...", "state": "<workflow state name>", "stage": "todo", "description": "...", "priority": "high", "dueDate": "<YYYY-MM-DD, or null>", "openSubIssues": false, "pullRequests": [], "blocks": false }
  ],
  "workspaces": [
    { "integration": "<integration or instance>", "id": "...", "name": "...", "branch": "...", "section": "<section, or null>", "current": false }
  ]
}`

export const ticketsToWorkFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "tickets-to-work",
  title: "{{cmd}}tickets-to-work",
  frontmatter: {
    description:
      "Go through your open issues that have no pull request or workspace yet, most urgent first, and start, skip, or close each one.",
    argumentHint:
      "[--priority <ranks>] [--limit <n>] [--section <name> | --section-by-rank] [--in <integration>] [help]",
  },
  commands: DEV_COMMANDS.defineCommands({
    hooks: HOOKS_COMMAND,
    configure: CONFIGURE_INTEGRATIONS,
    work: {
      description:
        "`list` puts the issues with no work started yet in the order to pick them up",
      args: "<subcommand>",
    },
  }),
  tools: {},
  compile: { mode: { default: "monolith" }, inlinePhases: [] },
  entries: { default: "main/list", help: "main/help" },
  defaultMode: "default",
  intro: `Walks through the open issues assigned to you that have no pull request, workspace, or git worktree yet, most urgent first, and decides each one with you: start it (through \`{{cmd}}start-work\`: a workspace with a coding agent on it, and the issue moved to in progress), skip it, or close it. One issue at a time, one question each. Issues are read and closed through the repo's configured issue tracker, and workspaces through its workspaces integration (\`{{cmd}}configure\`).`,
  invariants: [
    "**Act through the integrations' ops.** Issues are read and closed, and workspaces listed, only through the ops `configure.ts integrations` returns, run as given; workspaces open only through `{{cmd}}start-work`.",
    "**The person decides every issue.** One question per issue, never several in one, never skipped because the answer looks obvious.",
    hooksInvariant("tickets-to-work"),
  ],
  phases: [
    {
      id: "main",
      title: "Main",
      stepStyle: "headers",
      steps: [
        {
          id: "help",
          kind: "action",
          title: "Help shortcut",
          preamble: true,
          body: `If the argument is \`help\`, print the block below verbatim and stop.

\`\`\`
{{cmd}}tickets-to-work  [--priority <ranks>] [--limit <n>]
                              [--section <name> | --section-by-rank]
                              [--in <integration>] [help]

Goes through your open issues that have no pull request, workspace, or git
worktree yet, most urgent first (then the ones whose title has the team's
blocker mark, then the ones blocking other work, then the earliest due),
and asks about each one:
  - Start: opens a workspace with a coding agent on it and moves the issue
    to in progress ({{cmd}}start-work)
  - Skip: leaves it for later
  - Close: moves it to canceled (or done, if you say so)
  - Stop: ends the run
An issue with open sub-issues is left out: its sub-issues are the work.
--priority <ranks>: only these priorities: urgent, high, medium, low, none,
  or the names the repo's agent instructions give them (--priority urgent,p0)
--limit <n>: only the first n issues, after --priority
--section <name>: puts started workspaces in that sidebar section; without
  it they go in no section
--section-by-rank: puts each started workspace in the section named after
  its issue's priority, making it when there is none yet
--in <integration>: opens them with that workspaces integration, when the
  repo configured more than one
\`\`\``,
          next: "main/list",
        },
        {
          id: "list",
          kind: "action",
          title: "List the issues",
          commandCalls: ["configure", "work"],
          body: `1. **Flags.** Take \`--priority <ranks>\`, \`--limit <n>\`, \`--section <name>\`, \`--section-by-rank\`, and \`--in <integration>\` out of \`{{argsToken}}\`. ${UNKNOWN_FLAGS} Read plain words the same way: "only urgent and P0" is \`--priority urgent,p0\`, "just 5" or "top 5" is \`--limit 5\`, "sort them into sections by priority" is \`--section-by-rank\`. When both \`--section-by-rank\` and \`--section\` are given, \`--section-by-rank\` wins: say once that \`--section\` is ignored.
2. **Integrations.** \`{{command:configure}} integrations issueTracker workspaces\`. ${REQUIRE_CONFIG} ${USE_INTEGRATIONS} Closing an issue needs its entry at \`level\` \`track\`; at \`link\`, its issues can be started or skipped, not closed.
3. **The issues.** \`<dir>\` is ${flowDir("tickets-to-work")} (create it). Run every \`issueTracker\` entry's \`assignedIssues\` op and every \`workspaces\` entry's \`workspaces\` op, and write them to \`<dir>/issues.json\`:

   \`\`\`json
   ${INPUT_EXAMPLE.split("\n").join("\n   ")}
   \`\`\`

   ${STAGES}. A workspace's \`section\` is \`null\` when it has none. When no variant of a \`workspaces\` op works here, leave its workspaces out and say so: \`work.ts\` still checks this repo's git worktrees. Then, passing \`--priority\` and \`--limit\` only when given:

   \`\`\`bash
   {{command:work}} list --input <dir>/issues.json [--priority <ranks>] [--limit <n>] [--ranks <names>]
   \`\`\`

   ${RANKS}. It reads the config's \`tickets.blockerMark\` itself, and marks an issue whose title has it \`blocker\`. It prints one \`TICKET\` line per issue with no work started yet (no open sub-issues, no pull request, and no workspace or git worktree on its branch), already in the order to go through them, then \`COUNT <n>\` (the issues printed) and \`TOTAL <n>\` (before \`--priority\` and \`--limit\`). Exit code 2 is an unknown \`--priority\` rank (say which ones exist, and stop) or bad input (fix \`issues.json\` and run it again).

When \`COUNT\` is 0, say there is nothing waiting and stop; when \`TOTAL\` is above 0, say instead that the filters left out all \`TOTAL\` issues, and stop. Otherwise say how many issues there are, and when \`COUNT\` is less than \`TOTAL\`, how many the filters left out.`,
          next: "main/decide",
        },
        {
          id: "decide",
          kind: "action",
          title: "Decide each issue",
          body: `Take the issues in the printed order, one at a time. Each gets its own question, asked {{askUser}}as one question per call: never several issues in one question, never an issue decided for the person, and never a question skipped because the answer looks obvious. The question names the issue: its id and title, then its priority, its due date (saying when it's past), its state, whether it stops a customer (\`blocker\`) or blocks other work, and its link. It offers all four options, Stop included, so the person can end the run from any issue:

- **Start:** open a workspace with a coding agent on it and move the issue to in progress.
- **Skip:** leave it and move on.
- **Close:** move it to canceled. Leave this option out when the issue's tracker entry is at \`link\`.
- **Stop:** end the run here.

Act on the answer before asking about the next issue:

- **Start:** run the \`{{cmd}}start-work\` skill with \`<ID> --yes\`, plus \`--section-by-rank\` when it was given, else \`--section "<name>"\` when that was, else \`--no-section\` (so the workspace lands in no section rather than this one's), plus \`--in <integration>\` when given, and follow it through. The answer is the go-ahead, which is what \`--yes\` tells it, so it doesn't ask again. Report its row for the issue; on a failure, say so and keep going.
- **Skip:** move on.
- **Close:** the entry's \`updateIssue\` op with only the state \`canceled\`, or \`done\` when the person says the work is already done. Leave the title, description, and fields out.
- **Stop:** go to the report.`,
          next: "main/report",
        },
        {
          id: "report",
          kind: "action",
          title: "Report",
          body: `List what happened in three groups: started (issue link and branch, and the command to start the agent when the integration couldn't), closed (issue link and the state it moved to), and skipped. Then say how many issues weren't reached when the run stopped early. Anything that failed goes first.`,
          next: null,
        },
      ],
    },
  ],
})

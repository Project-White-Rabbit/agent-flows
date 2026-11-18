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
    { "id": "<ID>", "title": "...", "url": "...", "state": "<workflow state name>", "stage": "todo", "description": "...", "priority": "high", "dueDate": "<YYYY-MM-DD, or null>", "createdAt": "<when it was filed>", "creator": "<who filed it, or null>", "project": "<its tracker project, or null>", "openSubIssues": false, "pullRequests": [], "blocks": false, "link": false }
  ],
  "workspaces": [
    { "integration": "<integration or instance>", "id": "...", "name": "...", "branch": "...", "section": "<section, or null>", "current": false }
  ],
  "repositories": [
    { "name": "<as --workspaces-repository takes it>", "remote": "<host>/<owner>/<repo>, or null", "path": "<its main checkout, or null>", "current": true }
  ]
}`

export const startTicketQueueFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "start-ticket-queue",
  title: "{{cmd}}start-ticket-queue",
  frontmatter: {
    description:
      "Go through your open issues that have no pull request or workspace yet, most urgent first, and start, skip, or close each one.",
    argumentHint:
      "[--priority <ranks>] [--limit <n>] [--section <name> | --section-by-rank] [--workspaces <entry>] [help]",
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
  intro: `Walks through the open issues assigned to you that have no pull request, workspace, or git worktree yet, most urgent first, and decides each one with you: start it (through \`{{cmd}}start-work\`: a workspace with a coding agent on it, in the repository the issue's work lands in, and the issue moved to in progress), skip it, or close it. One issue at a time, one question each. A start runs in the background, so the next question comes right away, and every start's result reaches you by the report. Issues are read and closed through the repo's configured issue tracker, and workspaces through its workspaces integration (\`{{cmd}}configure\`).`,
  invariants: [
    "**Act through the integrations' ops.** Issues are read and closed, and workspaces listed, only through the ops `configure.ts integrations` returns, run as given; workspaces open only through `{{cmd}}start-work`.",
    "**The person decides every issue.** One question per issue, never several in one, never skipped because the answer looks obvious.",
    "**Every start opens where its work lands.** Each question shows the repository the issue would open in, and an issue whose repository is unclear is asked about, never opened in this one by default.",
    "**Every start reaches the person.** A start runs in the background, but its result (started, already open, skipped, or failed) is told before the report or in it, and the report waits for every start still running.",
    hooksInvariant("start-ticket-queue"),
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
{{cmd}}start-ticket-queue  [--priority <ranks>] [--limit <n>]
                              [--section <name> | --section-by-rank]
                              [--workspaces <entry>] [help]

Goes through your open issues that have no pull request, workspace, or git
worktree yet, most urgent first (then the ones whose title has the team's
blocker mark, then the earliest due, then the ones blocking other work),
and asks about each one:
  - Start: opens a workspace with a coding agent on it and moves the issue
    to in progress ({{cmd}}start-work), in the background, so the next
    question comes right away. It opens in the repository the issue's work
    lands in (the one it names, the one the config's tickets.repositories
    maps its project to, or the one holding the code it names), shown in
    the question; name another to open it there, and when it's unclear,
    you're asked which
  - Skip: leaves it for later
  - Close: moves it to canceled (or done, if you say so)
  - Stop: ends the run
An issue with open sub-issues is left out: its sub-issues are the work.
--priority <ranks>: only these priorities: urgent, high, medium, low, none,
  or the names the config's tickets.ranks gives them (--priority urgent,p0)
--limit <n>: only the first n issues, after --priority
--section <name>: puts started workspaces in that sidebar section; without
  it they go in no section
--section-by-rank: puts each started workspace in the section named after
  its issue's priority, making it when there is none yet
--workspaces <entry>: opens them with that workspaces integration (its
  instance or integration name), when the repo configured more than one
\`\`\``,
          next: "main/list",
        },
        {
          id: "list",
          kind: "action",
          title: "List the issues",
          commandCalls: ["configure", "work"],
          body: `1. **Flags.** Take \`--priority <ranks>\`, \`--limit <n>\`, \`--section <name>\`, \`--section-by-rank\`, and \`--workspaces <entry>\` out of \`{{argsToken}}\`. ${UNKNOWN_FLAGS} Read plain words the same way: "only urgent and P0" is \`--priority urgent,p0\`, "just 5" or "top 5" is \`--limit 5\`, "sort them into sections by priority" is \`--section-by-rank\`. When both \`--section-by-rank\` and \`--section\` are given, \`--section-by-rank\` wins: say once that \`--section\` is ignored.
2. **Integrations.** \`{{command:configure}} integrations issueTracker workspaces\`. ${REQUIRE_CONFIG} ${USE_INTEGRATIONS} Closing an issue needs its entry at \`level\` \`track\`; at \`link\`, its issues can be started or skipped, not closed.
3. **The issues.** \`<dir>\` is ${flowDir("start-ticket-queue")} (create it). Run every \`issueTracker\` entry's \`assignedIssues\` op and every \`workspaces\` entry's \`workspaces\` op, and write them to \`<dir>/issues.json\`, each issue with \`"link": true\` when its entry is at \`link\` (read-only):

   \`\`\`json
   ${INPUT_EXAMPLE.split("\n").join("\n   ")}
   \`\`\`

   \`project\` is its tracker project's name, or \`null\`. ${STAGES}. A workspace's \`section\` is \`null\` when it has none. \`repositories\` is what the \`repositories\` op of the \`workspaces\` entry new workspaces open with (the one \`--workspaces\` names, by \`instance\` or \`integration\`, else the first) prints, run once for the whole run; when no variant of it works here, leave \`repositories\` out and say every issue opens in this repository. When no variant of a \`workspaces\` op works here, leave its workspaces out and say so: \`work.ts\` still checks this repo's git worktrees. Then, passing \`--priority\` and \`--limit\` only when given:

   \`\`\`bash
   {{command:work}} list --input <dir>/issues.json [--priority <ranks>] [--limit <n>] [--ranks <names>] [--no-linked]
   \`\`\`

   ${RANKS}. It reads the config's \`tickets.blockerMark\` itself, and marks an issue whose title has it \`blocker\`. It leaves out the issues marked \`link\` when the config's \`tickets.queueLinked\` is false, and with \`--no-linked\` (pass it when the person asks to leave the read-only trackers out this time: "only our own tracker"). It prints one \`TICKET\` line per issue with no work started yet (no open sub-issues, no pull request, and no workspace or git worktree on its branch), already in the order to go through them, then \`COUNT <n>\` (the issues printed) and \`TOTAL <n>\` (before \`--priority\` and \`--limit\`). With \`repositories\`, each line ends with the repository its work lands in: \`repo="<name>"\` and \`from=\` why (\`named\`: the issue names it; \`project\`: the config's \`tickets.repositories\` maps its project to it; \`code\`: that checkout holds the paths it names; \`only\`: there's no other), plus \`here\` when that's this repository; or \`repo=?\` when it's unclear, with \`candidates="<names>"\` when the issue names more than one. Exit code 2 is an unknown \`--priority\` rank (say which ones exist, and stop) or bad input (fix \`issues.json\` and run it again).

When \`COUNT\` is 0, say there is nothing waiting and stop; when \`TOTAL\` is above 0, say instead that the filters left out all \`TOTAL\` issues, and stop. Otherwise say how many issues there are, and when \`COUNT\` is less than \`TOTAL\`, how many the filters left out.`,
          next: "main/decide",
        },
        {
          id: "decide",
          kind: "action",
          title: "Decide each issue",
          body: `**The repository.** Each issue starts in the repository on its \`TICKET\` line. Before asking about one with \`repo=?\`, look where the code it names lives: search each candidate's checkout (every repository with a \`path\` when there are no candidates) for the files, modules, functions, endpoints, or features its title and description name. When one checkout clearly holds them and the others don't, that's its repository (where the code it names is); otherwise it stays unclear. Never settle an unclear one on this repository because the queue runs here. Without \`repositories\`, every issue starts here, and the question names no repository.

Take the issues in the printed order, one at a time. Each gets its own question, asked {{askUser}}as one question per call: never several issues in one question, never an issue decided for the person, and never a question skipped because the answer looks obvious. The question names the issue: its id and title, then its priority, its due date (saying when it's past), when it was filed and who filed it (the \`TICKET\` line's \`filed\` and \`by\`; leave out what it doesn't say), its state, whether it stops a customer (\`blocker\`) or blocks other work, and its link. Then the repository it would open in and why: \`Repository: noah-server (the issue names it)\`, \`(its project, Scenarios)\`, \`(where the code it names is)\`, or \`(the only one)\`, adding \`, this one\` when it's this repository; or \`Repository: unclear\`, saying what it names (\`it names ai-assistant and noah-server\`) or that nothing in it points to one. It offers all four options, Stop included, so the person can end the run from any issue:

- **Start:** open a workspace with a coding agent on it, in that repository, and move the issue to in progress. Its label names the repository (\`Start in noah-server\`), and its description says that answering with another repository's name starts it there instead. When the repository is unclear, its label is \`Start (choose the repository)\`.
- **Skip:** leave it and move on.
- **Close:** move it to canceled. Leave this option out when the issue's tracker entry is at \`link\`.
- **Stop:** end the run here.

Act on the answer before asking about the next issue:

- **Start:** first settle the repository. An answer naming a repository (\`start in web\`) takes that one: the one of \`repositories\` with that \`name\`, or whose remote's or path's last part is it; when none is, say which ones there are and ask again. When the repository is unclear and the answer names none, ask which one in a question of its own, the repositories as its options, the ones the issue names first (with more than fit, the rest go under the free answer); it's part of deciding the same issue. Then start it in the background, and ask about the next issue in the same turn, without waiting for it. Hand a subagent that runs in the background (on Claude Code, the \`Agent\` tool) this task, with \`<ID>\` and the flags filled in: "Run {{flow:start-work}} with \`<ID> --yes --run <ID> <flags>\` and follow it through. Answer with its report row for <ID>: what happened (started, already open, skipped and why, or failed and why), the issue's link, its branch and section, whether it moved to in progress, and the command that starts the agent when the integration couldn't start one." The flags are \`--section-by-rank\` when it was given, else \`--section "<name>"\` when that was, else \`--no-section\` (so the workspace lands in no section rather than this one's), plus \`--workspaces <entry>\` when given, plus \`--workspaces-repository "<name>"\` with the repository's \`name\` when it isn't this one (\`current\` false), so the workspace opens there. The answer is the go-ahead, which is what \`--yes\` tells it, so it doesn't ask again. Starts running at once don't race: \`--run <ID>\` keeps each one's files apart, and start-work holds the repo's lock while it opens a workspace. Keep a list of the starts still running. When this host can't run a subagent in the background, run \`{{cmd}}start-work\` here instead, with the same arguments, and tell its row before the next question.
- **Skip:** move on.
- **Close:** the entry's \`updateIssue\` op with only the state \`canceled\`, or \`done\` when the person says the work is already done. Leave the title, description, and fields out.
- **Stop:** go to the report.

**Background results.** Each start's result comes back when it finishes. Tell the ones that came back in the same message as the next question, before it, one line each and failures first, rather than in a turn of their own. A start that ended without a row (its subagent errored or was stopped) failed: say it's unknown whether its workspace opened, and that \`{{cmd}}start-work <ID>\` finishes it (it opens only what didn't). Results that come back after the last question wait for the report.`,
          next: "main/report",
        },
        {
          id: "report",
          kind: "action",
          title: "Report",
          body: `First wait for every start still running: say which ones, and don't report until each has come back. Never guess a result that hasn't. Then list what happened, every start's result included, even ones already told, in three groups: started (issue link, branch, and the repository when it isn't this one, and the command to start the agent when the integration couldn't; an issue start-work found already open or skipped says so), closed (issue link and the state it moved to), and skipped. Then say how many issues weren't reached when the run stopped early. Anything that failed goes first.`,
          next: null,
        },
      ],
    },
  ],
})

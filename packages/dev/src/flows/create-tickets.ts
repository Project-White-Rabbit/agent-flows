import type { Flow } from "@agent-flows/core"
import { ISSUE_FIELD_RULES } from "./issues.ts"
import {
  CONFIGURE_GET_AND_INTEGRATIONS,
  DEV_COMMANDS,
  devKit,
  flowDir,
  HOOKS_COMMAND,
  hooksInvariant,
  REQUIRE_CONFIG,
  UNKNOWN_FLAGS,
  USE_INTEGRATIONS,
} from "./kit.ts"

const PLAN_EXAMPLE = `{
  "source": { "title": "Planning, Oct 24", "url": "<the notes' URL; omit for pasted notes>" },
  "items": [
    { "key": "sync", "title": "Sync planning with the dev workflow", "priority": "high", "assignee": "Sam", "project": "Dev tools",
      "description": "What the work is and when it's done.\\n\\n- [ ] Pick the next task from a coding agent\\n- [ ] Post issue changes to chat",
      "label": "Feature", "defaults": ["project"] },
    { "key": "bot", "title": "Answer issue questions in chat", "cycle": "next", "blockedBy": ["sync"] },
    { "key": "login", "title": "Fix login for Acme", "priority": "urgent", "dueDate": "2026-10-30", "blocker": true }
  ],
  "options": { "<entry>": { "people": [{ "name": "Sam Lee" }], "projects": ["Dev tools"], "labels": ["Feature"], "cycles": [{ "id": "40", "startsAt": "2026-10-19", "endsAt": "2026-10-26", "current": true }] } },
  "refs": { "<ID>": { "found": true, "title": "...", "closed": false, "priority": "high", "project": "Dev tools", "subIssues": [] } }
}`

export const createTicketsFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "create-tickets",
  title: "{{cmd}}create-tickets",
  frontmatter: {
    description:
      "File issues from planning notes, a page link, or a sentence, updating issues that already describe the same work. Not for syncing a branch.",
    argumentHint: {
      deriveFromModes: true,
      suffix: "[notes URL | pasted notes | sentence] [--yes]",
    },
  },
  commands: DEV_COMMANDS.defineCommands({
    hooks: HOOKS_COMMAND,
    configure: CONFIGURE_GET_AND_INTEGRATIONS,
    tickets: {
      description:
        "`match` ranks the tracker's issues against each item and sets the certain matches; `check` checks the plan against the team's rules and prints the table to confirm (or `PROBLEM` lines); `record` saves an issue apply just filed into the plan; `notes` and `planning-line` shape the planning document's section and each issue's link to it",
      args: "<subcommand>",
    },
  }),
  tools: {},
  compile: {
    // Match mode (how sync looks for a branch's issue) stops after matching,
    // so it never loads the confirm or apply prose.
    mode: { default: "split-chain" },
    inlinePhases: ["main"],
  },
  entries: {
    default: "main/read",
    match: "main/read",
    help: "main/help",
  },
  defaultMode: "default",
  modeHints: {
    default:
      "Turn the notes into issues: draft a plan, match it against existing issues, confirm one table, and file it.",
    match:
      "Only look: draft the plan and find the issues that already describe it. Files and changes nothing. Sync uses it with `--branch`.",
    help: "Show usage and exit.",
  },
  intro:
    "Turns planning notes into issues in the repo's issue tracker: each planned item becomes one issue, with its action items as a checklist in the description rather than sub-issues (the people doing the work split those out if they want them). Issues that already describe the same work are updated instead of filed twice, and the whole result is shown as one table and filed on one confirmation. Every tracker action goes through the repo's configured integrations (`{{cmd}}configure`), so it works with any issue tracker.\n\nIn default mode, `--yes` anywhere in the arguments skips the confirmation when nothing needs an answer; the rest is the notes. In `match` mode, `--branch <branch>` says the text describes that branch's work; the rest is the text.\n\nThe `tickets.ts` command checks the plan and draws the table; you turn the notes into a plan, match it, show the table, and apply it. Aim for three turns: draft, confirm, apply.",
  invariants: [
    "**Act through the integrations' ops.** Issues are searched, filed, updated, and linked only through the ops `configure.ts integrations` returns, run as given.",
    "**File only what the notes describe.** Don't invent work, and don't split an item into sub-issues the notes don't ask for.",
    "**Existing issues keep their title, description, and parent,** apart from the blocker mark on the title, the `> Planning:` line in the description, and a parent the plan moves them to. An update sets only what the plan changes.",
    "**Nothing is written before the confirmation** (or `--yes`), and nothing at all in `match` mode.",
    hooksInvariant("create-tickets"),
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
          body: `If mode is \`help\`, print the block below verbatim and exit. No reads, no writes.

> \`{{cmd}}create-tickets\` files issues from planning notes.
>
> Usage:
>   - \`{{cmd}}create-tickets <notes URL | pasted notes | sentence> [--yes]\` -- each planned item becomes one issue, its action items a checklist in the description. Issues that already describe the same work are updated instead, and work closed in the last 90 days is flagged, not filed again. Shows one table and files everything on one confirmation (\`--yes\` skips it when nothing needs an answer). Running it again on the same notes only updates.
>   - \`{{cmd}}create-tickets match [--branch <branch>] <text>\` -- only find the issues that already describe the work. Files and changes nothing. Sync uses it to find a branch's issue.
>   - \`help\` -- show this and exit
>
> Priority, labels, estimate, cycle, project, assignee, and due date come from the notes, then the repo's agent instructions, then the issue tracker's config. Names the tracker doesn't know (people, projects, labels, cycles, and blocked-by issues) are reported before anything is filed. The config's \`tickets\` section adds the team's rules: due dates required at some priorities, a parent ranked by its sub-issues, a blocker mark on titles, and a planning document per cycle that records the notes and links each issue back. New issues are filed in the todo state. It needs an issue tracker (\`{{cmd}}configure issueTracker\`), at \`track\` to file.`,
          next: null,
        },
        {
          id: "read",
          kind: "action",
          title: "Read the notes",
          refName: "read the notes",
          commandCalls: ["configure"],
          body: `1. **Issue tracker:** \`{{command:configure}} integrations issueTracker\` prints every entry the repo configured. ${REQUIRE_CONFIG} ${USE_INTEGRATIONS}
   - Every entry is searched. Only entries at \`level\` \`track\` get issues filed or updated: file in the first of those, unless the notes, the user, or the repo's agent instructions name another. An entry at \`link\` is read-only here.
   - In default mode with no entry at \`track\`, stop: \`Every issue tracker here is linked only, so create-tickets can't file. Run {{cmd}}configure <integration> to track issues, or use {{cmd}}create-tickets match to look without filing.\`
2. **The notes**, from the arguments (minus the mode keyword and flags):
   - **Flags:** \`--yes\` in default mode, \`--branch <branch>\` in \`match\` mode. ${UNKNOWN_FLAGS}
   - **A URL:** read the page with this session's tools for that site (an MCP server's fetch or read tool; search for deferred ones before deciding there are none), else a plain web fetch. When nothing can read it (it needs a sign-in no tool has), ask the person to paste the page and stop until they do.
   - **Pasted notes** (often a flat list with no headings, copied from a chat channel or a doc) **or a sentence:** use the text as given.
   - **Nothing:** ask for the notes or a link, and stop.
3. **Where the plan goes:** \`<dir>\` is ${flowDir("create-tickets")} (create it), so the plan never lands in the tree. The plan is \`<dir>/plan.json\` in default mode and \`<dir>/match.json\` in \`match\` mode, so looking never overwrites a notes plan or the issues it recorded as filed. In default mode, write the notes as you read them, unedited, to \`<dir>/notes.md\`: the planning document records them as they are.
4. **The team's rules:** \`{{command:configure}} get tickets.planningDoc tickets.blockerMark tickets.dueDateRequired tickets.parentFollowsSubIssues --optional\`. \`null\` means the team doesn't use that rule. \`tickets.ts check\` applies the last three itself; you need them to draft (a blocker, a date to ask for) and \`planningDoc\` to apply.`,
          next: "main/draft",
        },
        {
          id: "draft",
          kind: "action",
          title: "Draft the plan",
          refName: "draft the plan",
          body: `Read the repo's agent instructions (\`AGENTS.md\`, \`CLAUDE.md\`, and the docs they point to for ranking or filing work): its priority scale, labels, and what an issue should say. Then write the plan:

\`\`\`json
${PLAN_EXAMPLE}
\`\`\`

| Field | Rule |
|---|---|
| \`key\` | Short and unique. \`parent\` and \`blockedBy\` refer to keys, or to an existing issue's id. |
| \`title\` | Plain words saying what the work does, never an issue id. |
| \`description\` | What the work is and when it's done, then its action items as a checklist (\`- [ ] ...\`). |
| \`parent\` | Usually left out: each planned item is one issue however many pull requests it takes, and its action items go in its checklist, never into sub-issues. In flat notes with no headings, fold lines into one item when they're clearly parts of the same work; otherwise each line is its own item. Set it only when the notes name an existing issue the work belongs under (matching may add one too). On a matched item, a parent other than the issue's own moves it there. |
| \`priority\` | \`urgent\`, \`high\`, \`medium\`, \`low\`, or \`none\`, from how the notes rank the work, read through the agent instructions' scale (a team's P0 might be \`high\`, and its lowest rank, an audit say, \`none\`). A name from the config's \`tickets.ranks\` works too (\`"P0"\`): \`check\` reads it as the priority it names, and the table shows both (\`high (P0)\`). On a matched item, set it from how the notes rank the work even when the issue already has it, so an issue the notes moved doesn't keep its old rank. On a new item the notes don't rank, the tracker entry's \`values.priority\` or the agent instructions' default, listed in \`defaults\`; with neither, leave it out. With \`tickets.parentFollowsSubIssues\`, the check raises a parent to its most urgent open sub-issue. |
| \`cycle\` | When the work happens: \`current\`, \`next\`, a cycle number, or a \`YYYY-MM-DD\` date inside it, from the notes ("this week", "next week", "after the launch"). Otherwise as the issue fields below say, listed in \`defaults\`. |
| \`dueDate\` | \`YYYY-MM-DD\`, only from the notes (or the agent instructions or \`tickets.dueDateRequired\`, when they require one for some work: ask for it at the confirmation). \`null\` clears a matched issue's date; leaving it out keeps it. |
| \`blocker\` | \`true\` only when the work stops a customer from making progress, and only with \`tickets.blockerMark\`: the title gets the mark. Work that holds up a teammate or another issue isn't a blocker: use \`blockedBy\` on the issue it holds up. |
| \`assignee\` | The person the notes name (a first name is enough). Leave it out for the person running this. One person per issue. |
| \`project\` | The one the notes name for the area (part of its name is enough when only one project has it), else the entry's \`values.project\`, listed in \`defaults\`. A new sub-issue the notes give no project takes its parent's, which the check fills in. |
| \`label\` | One label from the set the agent instructions or the entry's \`values.labels\` give, by the kind of work. Leave it out with no set. |
| \`estimate\` | Only when the agent instructions or the entry's \`values.estimate\` ask for one. |
| \`blockedBy\` | Only when the notes say one piece of work waits on another. Work that holds up a teammate is not a reason on its own. |
| \`tracker\` | The entry to file in (its \`instance\` or \`integration\`), only when it isn't the first at \`track\`. |
| \`defaults\` | The fields set from a default rather than read from the notes, so the table marks them for checking. |
| \`match\`, \`existing\` | Leave them out: matching sets them. |

Don't invent work the notes don't mention.

**What the tracker knows:** in default mode, run the filing entry's \`fieldOptions\` op once and put its JSON in the plan's \`options\`, under the entry's \`instance\` (else its \`integration\`); for an item filed in another entry, that entry's too. \`tickets.ts check\` then reports a person, project, label, or cycle the tracker doesn't have, with the names it does, and checks due dates against when cycles start. When the op is \`unsupported\` or no variant works here, leave \`options\` out: names go unchecked, so say so at the confirmation.

**Running again on the same notes:** when the plan file already exists with the same \`source\`, start from it. Its items with a \`match\` are issues filed or matched last time; keep those matches, so a re-run only updates.

**In \`match\` mode** the text is usually one item: draft it as one, unless it plainly lists several pieces of work. With \`--branch\`, it's that branch's work: judge it against this session and the branch's commits too.`,
          next: "main/match",
        },
        {
          id: "match",
          kind: "action",
          title: "Find matches",
          refName: "find matches",
          commandCalls: ["tickets"],
          body: `**Rank every issue against the plan.** For each entry, run its \`recentIssues\` op once (every open issue, and every one closed in the last 90 days), and its \`searchIssues\` op once per item with the item's title. Write them to \`<dir>/issues.json\`, under each entry's \`instance\` (else its \`integration\`):

\`\`\`json
{ "<entry>": { "link": false, "issues": [<recentIssues' issues>], "hits": { "<item key>": ["<ID>", "..."] } } }
\`\`\`

\`link\` is true for an entry at \`link\`, and \`hits\` each item's search results by id, best first. When \`recentIssues\` is \`unsupported\` or fails, put the issues the searches returned in \`issues\` instead. Then:

\`\`\`bash
{{command:tickets}} match --plan <dir>/<plan file> --issues <dir>/issues.json [--notes <dir>/notes.md] [--branch <branch>]
\`\`\`

\`--notes\` in default mode, \`--branch\` in \`match\` mode with one. It scores every issue by the words it shares with each item's title and each line and sentence of its description, fuses that with the search's ranking, and prints per item an \`ITEM\` line, then \`CANDIDATE\` lines, best first (score, \`exact title\`, \`search #N\`, \`same notes\` when the issue was filed from these notes, \`closed\`), or \`NEW\` when nothing comes close. On an item with no \`match\` it sets one in the plan when it's certain, and prints \`MATCH exact title\` or \`MATCH same notes\`: the only open issue with the same title, or one filed from the same notes that clearly outscores the rest, in an entry it can update, claimed by no other item (with \`--branch\`, also with no pull request attached and no \`> Branch:\` line naming another branch). Keep those matches, set the item's \`tracker\` when the issue is in an entry other than the first at \`track\`, and load \`existing\` for them as below.

**Judge the rest.** For each item without a match, also run every entry's \`searchIssues\` op with each checklist line or sentence that names a distinct piece of the work (up to three), since an issue filed under another name may match on one line alone. Judge each candidate, the printed ones and these, against the whole item (its description and checklist, and with \`--branch\`, the branch's work), not the title alone. Decide without asking:

- **The same work, open:** set \`"match": "<ID>"\`, then load it with the entry's \`getIssue\` op and set \`existing\` from it: \`title\`, \`url\`, \`priority\`, \`cycle\`, \`cycleStart\` and \`cycleEnd\` (when its cycle starts and ends), \`dueDate\`, \`assignee\`, \`project\` (\`null\` when it has none and the tracker has projects), \`parent\`, \`subIssues\` (its open sub-issues: \`id\`, \`title\`, \`priority\`, \`cycle\`, \`cycleStart\`, \`cycleEnd\`, \`dueDate\`), and \`closed: false\`. Read its parent too: when it sits under the wrong one, or under none where an open issue covers the work as a whole, set \`parent\` to move it. With \`--branch\`, it's a match only when no pull request is attached and its description has no \`> Branch:\` line naming another branch; otherwise it's someone else's piece of the same work: the next case.
- **Part of a larger open issue** (it covers the work as a whole, like a project's main issue), or with \`--branch\`, the same work under another pull request or branch: set \`"parent": "<ID>"\` and leave \`match\` out, so the item is filed as a sub-issue of it rather than beside it.
- **Closed** (done or canceled in the last 90 days) **and the same work:** it's already done. Drop the item from the plan, and name the issue in the confirmation. With \`--branch\`, keep the item new and name the closed issue in the result: a closed issue is never a branch's issue.
- **In an entry at \`link\`:** never a match, since it can't be updated here. When it's the same work, drop the item and name the issue in the confirmation as already tracked there. With \`--branch\`, keep the item and list the issue as \`also tracked\`.
- **A loose overlap, or nothing fits:** leave the item new. Take a match only when it's clearly the same work.

**Open issues in the item's project:** when an item names a project (or gets one by default), run the entry's \`projectIssues\` op for it once per project, and judge those issues against the item too, even when the words barely overlap: an issue that covers the work under another name shows up there. When the op is \`unsupported\`, skip it.

For each candidate you weigh, look at its parent and its open sub-issues (\`getIssue\`): a parent that already covers the work as a whole is where a new item belongs (\`parent\`), and an open sub-issue may be the match itself.

**Issues the plan names but doesn't hold:** every \`parent\` or \`blockedBy\` that is an issue id rather than a plan key, and with \`tickets.parentFollowsSubIssues\` the parent of each matched item whose priority the plan raises, load with \`getIssue\` and record in the plan's \`refs\` under its id: \`found\` (false when the tracker has none), \`title\`, \`closed\`, \`priority\`, \`project\` (\`null\` for none), and \`subIssues\` as above. \`tickets.ts check\` reports one that isn't there.

Two items that match the same issue are one piece of work: merge them into one item. When no variant of \`searchIssues\` works here, leave every item new and say the search was skipped.

**In \`match\` mode, stop here.** Write nothing to the tracker. Print one line per item, then stop:

\`\`\`
<key>: match <ID> (<title>, <URL>)        the same open work
<key>: sub-issue of <ID> (<title>, <URL>)  part of a larger issue
<key>: new                                 nothing describes it yet
  closed: <ID> (<title>, <URL>)            a closed issue that did the same work (one line each)
  also tracked: <ID> (<title>, <URL>)      the same work in an entry at link (one line each)
search skipped: <why>                      only when no variant of searchIssues worked
\`\`\``,
          next: {
            byMode: {
              default: "confirm/confirm",
              match: null,
              help: null,
            },
          },
        },
      ],
    },
    {
      id: "confirm",
      title: "Confirm",
      stepStyle: "headers",
      steps: [
        {
          id: "confirm",
          kind: "action",
          title: "Show the table and confirm",
          refName: "confirm",
          commandCalls: ["tickets"],
          body: `\`<dir>\` and the tracker entries are from {{skill-ref:main}}.

\`\`\`bash
{{command:tickets}} check --plan <dir>/plan.json
\`\`\`

It writes nothing. \`PROBLEM\` lines (exit 1) block filing: a name the tracker doesn't have (fix it with one it lists), an issue the plan names but hasn't loaded or that doesn't exist, a due date the team's rules require, a due date before its cycle starts, a parent loop. Fix what you can in the plan and run it again, and put anything only the person can answer (a due date) into the confirmation question. Otherwise it prints the table, one row per issue to file, update, or leave as is, in the order apply files them (\`row N\` points at an issue filed in the same run), then a \`SUMMARY\` line, any \`NAME\` lines (a project or label the plan named by part of its name, with the tracker's full name, which the table shows and apply files with), and any \`CHECK\` lines.

Show the table and its \`SUMMARY\` line exactly as printed, then:

- The fields marked \`(default)\` came from a default rather than the notes, so they get checked.
- Each item dropped because a closed issue already did the work, and each issue already tracked in an entry at \`link\`, by id and title.
- How you read any weekday deadline (for example: "Mon EOD" read as today, Monday, with its date).
- Each \`CHECK\` line as a row of a short table: the issue, what's wrong, and the fix you propose: a new date or \`null\` for an overdue date (the issue's own, or an open sub-issue's), a lower priority for each sub-issue that forces its parent above the rank the notes gave it (or keeping the higher rank on purpose), and a project for a matched issue with none. They don't block filing, but each needs an answer first. Urgent issues the notes don't mention aren't a problem: plenty of work comes up outside planning, so don't list or ask about them.
- A project marked \`(parent)\` is the one a new sub-issue takes from its parent, unless the notes name another.
- Values marked \`(sub-issues)\` came from the issue's sub-issues (\`tickets.parentFollowsSubIssues\`): a parent takes its most urgent sub-issue's priority and, with no cycle, the earliest cycle of a sub-issue whose cycle hasn't ended. A row for an issue outside the plan is a parent its sub-issue moves up: one filed or moved under it, or one already there that the plan raises.
- Names left unchecked, when \`options\` is out of the plan.
- Anything else only the person can answer, such as a due date the agent instructions require.

Then ask once: file these, or what should change? For changes, edit the plan, run the same command, and show the new table. Fold the answers to \`CHECK\` lines into the plan the same way, so the table you file from has none left unanswered.

**With \`--yes\`,** skip the question when there are no \`CHECK\` lines and nothing only the person can answer: show the table and go straight to filing. Ask about just those lines when there are.`,
          next: "apply/apply",
        },
      ],
    },
    {
      id: "apply",
      title: "Apply",
      stepStyle: "headers",
      steps: [
        {
          id: "apply",
          kind: "action",
          title: "File and report",
          refName: "file and report",
          commandCalls: ["tickets"],
          body: `After a yes (or with \`--yes\` and nothing to ask). \`<dir>\` and the tracker entries are from {{skill-ref:main}}.

Run \`{{command:tickets}} check --plan <dir>/plan.json\` once more for the final row order, then go through the rows in order. An item files in its \`tracker\` entry, else the first entry at \`track\`. Each row's values are the ones the table shows: its title (with the blocker mark), its priority and cycle (with what came from sub-issues), and its project (with what came from its parent); a label \`check\` printed a \`NAME\` line for files under the full name it gives.

0. **The planning document,** when \`tickets.planningDoc\` is true: \`{{command:tickets}} notes --plan <dir>/plan.json --notes <dir>/notes.md --out <dir>/section.md\` prints the document's \`title\` and the section's \`key\`. Run the filing entry's \`recordNotes\` op with \`<title>\`, \`<section-file>\` \`<dir>/section.md\`, and \`<key>\`, and keep the document's title and URL it prints. It records the notes before anything is filed, so they're kept even if filing fails. When the op is \`unsupported\` or fails, carry on without the document and its links, and say so in the report.
1. **\`file\`:** the entry's \`createIssue\` op with the title, the description, \`<parent>\` (a parent key becomes the id that item was filed or matched as), \`<state>\` \`todo\`, and \`<fields>\` from the issue fields below. With the planning document, write the description to \`<dir>/<key>.md\` and run \`{{command:tickets}} planning-line --plan <dir>/plan.json --notes <dir>/notes.md --description <dir>/<key>.md --title <doc title> --url <doc URL>\` first, and file the file's text: it puts a \`> Planning:\` line linking the document on top. Right after each one, before the next row, save it so a re-run updates it rather than filing it twice:

   \`\`\`bash
   {{command:tickets}} record --plan <dir>/plan.json --key <key> --id <ID> --url <URL>
   \`\`\`

2. **\`update\`:** the entry's \`updateIssue\` op with only what the row changes: \`<fields>\` the plan changes, \`<parent>\` when the row's parent reads \`<old> → <new>\`, and \`<title>\` when it gains the blocker mark. With the planning document, also write the issue's description (from \`getIssue\`) to \`<dir>/<key>.md\` and run the same \`planning-line\` command on it; when it prints \`CHANGED\`, pass the file's text as \`<description>\`. Leave the state out, and the title and description otherwise: they stay as they are. A row for an issue outside the plan sets only its priority.
3. **\`unchanged\`:** nothing.
4. **Blocked by:** once every row is done, for each item's \`blockedBy\`, the entry's \`linkBlocked\` op with \`<ID>\` the item's issue and \`<blocker>\` the blocking one (a key becomes the id it was filed or matched as).
5. **The planning document's issues,** when step 0 recorded it: run the same \`notes\` command again (the plan now holds every issue filed), and the \`recordNotes\` op again with the new section, which replaces the one step 0 wrote.

When an op fails, carry on with the other rows and note it. A row that didn't file stays new in the plan, so running \`{{cmd}}create-tickets\` again on the same notes picks up where this left off.

#### Issue fields

Take each field from, in order: the notes and the user in this session, the repo's agent instructions (\`AGENTS.md\`, \`CLAUDE.md\`, and the docs they point to for ranking or filing work), then the entry's \`values\` of the same name; the plan already holds what you chose. A field the notes set counts as the user asking. Pass as \`<fields>\` only the fields that change.

${ISSUE_FIELD_RULES}

#### Report

Lead with anything that needs attention: a failed op (what failed and why), a skipped search, and items left unfiled. Then:

- Each issue filed, updated, or left unchanged, as a link: \`[<ID>: <title>](<URL>)\`, grouped by what happened.
- How many blocked-by links were made.
- The planning document, as a link, and whether it was created or updated; or why there's none.
- Items dropped because a closed issue did the work, and issues already tracked in an entry at \`link\`.`,
          next: null,
        },
      ],
    },
  ],
})

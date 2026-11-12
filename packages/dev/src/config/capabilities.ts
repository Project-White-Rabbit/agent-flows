// Every capability an integration can provide. Flows name these, never a
// vendor: "the configured source-control integrations", not "GitHub". To add
// one, list it here and add it to the `provides` of the integrations that fill
// it. Ops are added when a flow first needs them, and every provider must then
// implement them (the registry tests enforce it).

import type { CapabilitySpec } from "./types.ts"

// The fields sync and create-tickets set on an issue beyond its title and
// description. Each tracker maps them to its own: a cycle is a sprint elsewhere.
const ISSUE_FIELDS =
  "priority (`urgent`, `high`, `medium`, `low`, or `none`, a team's lowest rank), estimate (on the team's scale), labels (names), cycle (`current`: the one in progress, `next`: the one after it, or a `YYYY-MM-DD` date inside one), project (a name), assignee (a person's name or email), and due date (`YYYY-MM-DD`, or `null` to clear it)"

const PR_FIELDS =
  "number, url, title, body, state, whether it's a draft, base and head branches, additions, deletions, and changed-file count"

// What the `checks` op prints, so `ready.ts ci` can read any host's checks.
const CHECKS_SHAPE =
  '`{"checks": [{"name", "state", "link", "log", "required", "codeScanning"}]}`, with `state` one of `pass`, `fail`, `pending` (queued or running), `skipping` (skipped, or allowed to fail), or `cancelled`, `link` the check\'s page, `log` the id `checkLog` reads its log by, left out when the host keeps no log for it (an outside service\'s status), `required` whether <base>\'s rules require it to pass before a merge, set only when <base> is given, and `codeScanning` true for a code-scanning check (CodeQL), whose findings are the `codeScanningAlerts` op\'s rather than a log, left out otherwise'

export const CAPABILITIES: CapabilitySpec[] = [
  {
    id: "sourceControl",
    name: "Source control",
    purpose: "The hosted repository: pull requests, CI checks, code review",
    levels: [
      { id: "read", description: "Read pull requests (evaluate)" },
      {
        id: "write",
        description:
          "Also push branches, open and edit draft pull requests (sync), mark them ready, resolve review threads (ready), and merge them (finish)",
      },
    ],
    defaultLevel: "write",
    ops: {
      prRef:
        "Which arguments name one of this host's pull requests: a bare number, or the host's pull request URL for this repository",
      currentPr: `The open pull request for the checked-out branch: ${PR_FIELDS}. No pull request, or the CLI missing or signed out, means there is none`,
      prMetadata: `Pull request <N>: ${PR_FIELDS}`,
      branchPr: `The most recent pull request whose head is branch <branch>, open, merged, or closed: ${PR_FIELDS}. None means there is none`,
      childPrs:
        'The open pull requests whose base is branch <branch>, all pages: `{"prs": [{"number", "url", "head"}]}`, `head` each one\'s head branch. An empty list means none; a list that can\'t be read is a failure, never an empty one',
      prDiff: "Pull request <N>'s full unified diff",
      prFiles: "Pull request <N>'s changed file paths, one per line",
      prCommits: "Pull request <N>'s commit subjects, one per line",
      prCreate:
        "Open a draft pull request from the checked-out branch into <base>, titled <title>, with the body in the file <body-file>; prints its URL",
      prEdit:
        "Set pull request <N>'s title to <title> and its body to the file <body-file>, leaving its draft or ready state alone",
      prMergeability:
        "Whether pull request <N> merges cleanly into its base: `clean`, `conflicting`, `behind` (the base moved and the host wants it caught up), or `pending` (the host is still computing it)",
      prMergeState:
        "Whether the host would merge pull request <N> now: `ready` (checks it doesn't require may still be failing), `blocked` with the reasons it gives (a required check, an approval, a rule, a draft), `conflicting`, `behind` (the base moved and the host requires it caught up), or `pending` (the host is still computing it)",
      prMerge:
        "Merge pull request <N> into its base by <method> (`squash`, `merge` for a merge commit, or `rebase`), only while its head is still commit <sha>, deleting no branch and bypassing no rule. A host that can't honor <method> per pull request says what it does instead; a refusal (a rule, a required check, a moved head) prints the host's reason",
      mergeCommit:
        'The commit merged pull request <N> landed as on its base (a merge commit, or the squashed or last rebased one): `{"sha": <its full sha>}`, or `{"sha": null}` while the pull request isn\'t merged',
      prClose:
        "Close pull request <N> without merging it, deleting no branch. One that's already closed stays as it is",
      prReady:
        "Mark pull request <N> ready for review. One that's already ready stays as it is",
      checks: `Every CI check and commit status on commit <sha>, all pages, as JSON: ${CHECKS_SHAPE}. With <base> (optional), each says whether merging into <base> requires it. An empty list means none has reported yet`,
      checkLog:
        "The last 200 lines of the log of check <log> (a check's `log` from the `checks` op)",
      reviewThreads:
        "Pull request <N>'s unresolved review threads, all pages: each with its id, file path and line, and its comments oldest first, each with its author, whether the author is a bot, and its text",
      resolveThread: "Mark review thread <id> on pull request <N> resolved",
      codeScanningAlerts:
        'Pull request <N>\'s open code-scanning alerts (CodeQL and other static analysis), all pages, as JSON: `{"alerts": [{"rule", "severity", "tool", "path", "line", "message", "url"}]}`. They stand in for the log of a check with `codeScanning` set',
    },
  },
  {
    id: "codeReview",
    name: "Code review on request",
    purpose:
      "An automated reviewer that reviews a pull request when asked (ready)",
    levels: [
      {
        id: "request",
        description:
          "Request a review only when a ready run asks for one (`--review`)",
      },
      {
        id: "every",
        description:
          "Request one on every ready run, unless it says `--no-review`",
      },
    ],
    defaultLevel: "request",
    ops: {
      requestReview:
        'Ask the reviewer to review pull request <pr>, whose head is commit <sha>, and print `{"requested": <when the host recorded the request, ISO 8601>, "url": <the request\'s link>}`. Every call is a new request, and may cost a paid run',
      reviewResult:
        'How the review requested at <requested> on pull request <pr> is going, as JSON: `{"state", "run", "findings": [{"author", "kind", "body", "url"}], "inline"}`. `state` is `pending` (not started or still running), `done`, `failed` (its run failed or was cancelled), `missing` (no run picked the request up within 3 minutes), or `skipped` (no run picked it up within 3 minutes, but one on the pull request since the request skipped: the workflow woke and its condition turned the request away); `run` is its run\'s link, or null. `findings` are the reviewer\'s comments and review summaries posted since <requested> (`kind` `comment` or `review`); its inline comments are review threads, read through the source-control `reviewThreads` op, and `inline` counts them',
    },
  },
  {
    id: "stacking",
    name: "Stacked PRs",
    purpose: "Stacked branches and pull requests on top of source control",
    exclusive: true,
    ops: {
      parent:
        "The checked-out branch's parent in its stack. Fails when the branch isn't tracked",
      track: "Start tracking the checked-out branch, stacked on <parent>",
      restack:
        "Bring the checked-out branch up to the latest commit of its parent (the fetched remote trunk, when the parent is trunk), by a rebase or a merge as the tool does it, stopping on conflicts",
      continue:
        "Carry on with an interrupted restack once its conflicts are resolved and staged",
      reparent:
        "Move the checked-out branch off <old>, its parent that has already merged, onto <onto>: replay only the branch's own commits (none of <old>'s, which <onto> already holds, squashed or not) onto the latest <onto> (the fetched remote one, when <onto> is trunk), record <onto> as its parent, and stop on conflicts",
      rename:
        "Rename the checked-out branch to <name>, keeping its place in the stack. A branch the tool doesn't track is renamed with git",
      submit:
        "Push the checked-out branch and open its pull request as a draft when it has none, leaving an existing pull request's title, body, and draft or ready state alone. Prints each pull request's URL, and its URL in the stacking tool's own app when it has one",
      downstack:
        '`{"chain": [<branch>...], "above": <n>, "size": <n>}`: `chain` the checked-out branch\'s ancestors in its stack as the tool records them, trunk left out, bottom first and ending with the checked-out branch; `above` how many branches stack on top of it; `size` how many its whole stack holds. A branch the tool doesn\'t track is a chain of one, with `above` 0 and `size` 1',
      prUrl:
        'The pull request at <url> (its URL on the source-control host) as a URL in the stacking tool\'s own app, built from that URL without calling the tool: `{"url": <its URL>}`, or `{"url": null}` when the tool has no app or no URL for that host',
      mergeStack:
        "Merge the pull requests of every branch in the checked-out branch's `downstack` chain, bottom first, up to and including it, retargeting and restacking each next branch as the one below it lands. Stops at the first one that can't merge, printing why. The host's or the tool's own merge method applies",
    },
  },
  {
    id: "issueTracker",
    name: "Issue tracker",
    purpose: "Tickets: link branches and PRs, file and close issues",
    levels: [
      {
        id: "link",
        description: "Find a branch's existing issue and link it from the PR",
      },
      {
        id: "track",
        description:
          "Also file an issue for every branch, and keep its status and state in step (sync)",
      },
    ],
    defaultLevel: "link",
    ops: {
      issueRef:
        "Which strings name one of this tracker's issues: an issue id, or the tracker's URL for one",
      getIssue: `Issue <ID>: its id, title, URL, workflow state, description, ${ISSUE_FIELDS}, the date its cycle starts, parent issue, open sub-issues (each with its id, title, priority, cycle and the date it starts, and due date), the pull requests attached (their URLs), and the branch name the tracker suggests for it, when it suggests one. Not found, or archived, means there is none`,
      findIssue:
        "Open issues anchored to branch <branch>, any assignee: their description has a `> Branch:` line naming it, in backticks or bare (as older tools wrote it), reading an issue id in it that the tracker turned into a link as plain text",
      searchIssues:
        "Issues that may already describe the work in <text>, any assignee: open ones, and ones closed in the last 90 days, ranked by the tracker's own search, each with its id, title, URL, workflow state, description, parent issue, and whether a pull request is attached",
      recentIssues:
        "Every issue that may already describe planned work, any assignee, all pages: the open ones, and the ones closed in the last 90 days, each with its id, title, URL, workflow state, whether it's open, whole description, parent issue, and attached pull requests. Searched as `searchIssues` is",
      projectIssues:
        "Every open issue in project <project>, any assignee, all pages: each with its id, title, URL, workflow state, priority, due date, and parent issue",
      fieldOptions:
        '`{"people": [{"name", "displayName", "email"}], "projects": [<name>], "labels": [<name>], "cycles": [{"id", "startsAt", "endsAt", "current"}]}`: the people issues can be assigned to (not apps or bots), the open projects, the labels, and the current and upcoming cycles (`id` its number or name, `current` true for the one in progress), as JSON. A field the tracker doesn\'t have is left out',
      recordNotes:
        "Put the section in the file <section-file> into the planning document titled <title>, in the current cycle (the team's, when cycles aren't documents' homes), creating it with that title when there's none: replace the `## ` section whose `Source:` line contains <key>, or add it at the end, keeping the rest. Prints the document's title and URL",
      assignedIssues:
        "Every open issue assigned to the current user, all pages: each with its id, title, URL, workflow state, description, priority, due date, whether it has open sub-issues, whether a pull request is attached, and whether it blocks another open issue",
      createIssue: `File an issue titled <title> with the description <description>, assigned to the current user unless <fields> names an assignee, as a sub-issue of <parent> when one is given, in the workflow state matching <state> when one is given (as for updateIssue; else the tracker's default), with <fields>: whichever of ${ISSUE_FIELDS} the flow sets, leaving out the rest. Prints its id and URL`,
      updateIssue: `Set issue <ID>'s title to <title>, its description to <description>, its workflow state to the one matching <state> (\`todo\`, \`in progress\`, \`in review\`, \`done\`, or \`canceled\`), its parent to <parent> (moving it from the one it has), and <fields> as for createIssue. Anything left out (the title, the description, the state, the parent, or a field) stays as it is`,
      linkBlocked:
        "Record that issue <ID> is blocked by issue <blocker>, keeping the relations it already has. Linking a pair that's already linked changes nothing",
      prLink:
        "Where a pull request names issue <ID> so the tracker links the two: a closing form, which also closes the issue when the pull request merges, and a linking-only form, when the tracker tells them apart",
    },
  },
  {
    id: "workspaces",
    name: "Workspaces",
    purpose:
      "Open a branch in a workspace of its own, with a coding agent already working on it",
    ops: {
      workspaces:
        "Every open (not archived) workspace of this repository, or of <repository> when one is given (another repository the integration manages, by name): each with its id, name, branch, and sidebar section (none when it has none), and whether this session runs in it",
      renameWorkspace:
        "Rename the workspace <id> to <name>. With <section>, file it in that sidebar section, making the section when there's none yet; with <section> `none`, take it out of every section; with no <section>, leave its section as it is. Its git branch is renamed separately",
      createWorkspace:
        "Open a new workspace of this repository, or of <repository> when one is given (another repository the integration manages, by name), named <name>, on the branch <branch> (made from <base> when it doesn't exist): exactly <branch> when <exact> is `yes`, else under the prefix the integration or the repo puts on new branches. File it in the sidebar section <section> when one is given, making the section when there's none yet. Start a coding agent in it on the prompt in the file <prompt-file>, or, when the integration can't start one, print the command that does. Prints the workspace's id, the branch it's on, and a link or path to open it",
    },
  },
  {
    id: "browser",
    name: "Browser",
    purpose:
      "A browser built into the workspace app, for opening a branch's preview or a mockup next to its agent (preview, prototype)",
    ops: {
      openUrl:
        "Show <url> in the app's browser beside workspace <workspace> (the id the `workspaces` op gives the one this session runs in), and bring it into view: in the tab already showing <origin> there when there is one, else in a new one, placed where the integration's `browser` field says (a tab of its own when unset). Prints the tab's id",
    },
  },
  {
    id: "design",
    name: "Design",
    purpose:
      "Where the team's designs live: the look prototype's mockups take, and where it puts them for the team",
    levels: [
      {
        id: "read",
        description:
          "Read the design system, so mockups take its look (prototype)",
      },
      {
        id: "write",
        description: "Also put mockups in it for the team (prototype)",
      },
    ],
    defaultLevel: "read",
    ops: {
      styleGuide:
        "The team's design system, from the design <link> when one is given, else the integration's own: its colors (as hex, with their names), text styles (font, size, weight, line height), radii, spacing, and the names of its main components, as a short list. Prints nothing found when there's no design system to read",
      showMockup:
        "Put the mockup page in the file <file> (one self-contained HTML page) in the design tool as editable designs titled <title>, one per screen or state it shows: in place of the ones at <link> when given, else as new ones beside what's already there, so nothing overlaps. Prints a link that opens them",
    },
  },
  {
    id: "deployments",
    name: "Deployments",
    purpose: "Preview and production deployments, runtime logs",
    ops: {
      deployment:
        'The deployment of commit <sha>, which just landed on its base: `{"state", "url", "steps": [{"name", "state", "log"}]}`. `state` is `none` (nothing has started deploying it yet), `pending` (queued or running), `success`, or `failed` (failed or cancelled); `url` is its page, or null with `none`; `steps` are the parts it ran, when the tool reports them (else an empty list): each one\'s `state` is `pending`, `success`, `failed`, or `skipped`, and its `log` is the id the source-control `checkLog` op reads its log by, left out when there\'s none',
    },
  },
  {
    id: "database",
    name: "Database",
    purpose: "Database branches per worktree, migrations",
    ops: {},
  },
  {
    id: "errorTracking",
    name: "Error tracking",
    purpose: "Production errors behind a bug",
    levels: [
      { id: "link", description: "Link the errors a branch fixes from its PR" },
      {
        id: "resolve",
        description: "Also resolve them when the PR merges (sync)",
      },
    ],
    defaultLevel: "link",
    ops: {
      issueRef:
        "Which strings name one of this project's error issues: a short id, or the tracker's URL for one",
      resolveIssue: "Mark error issue <issue> resolved",
    },
  },
  {
    id: "sessions",
    name: "Session sharing",
    purpose:
      "Share the agent session behind a change, linked from its PR and issue",
    ops: {
      shareSession:
        "Share the agent session this flow runs in with the team and print its URL. Sharing the same session again updates the same link",
    },
  },
  {
    id: "analytics",
    name: "Product analytics",
    purpose: "Usage events, funnels, session replay",
    ops: {},
  },
  {
    id: "featureFlags",
    name: "Feature flags",
    purpose: "Gated rollouts and experiments",
    ops: {},
  },
  {
    id: "chat",
    name: "Team chat",
    purpose: "Where dev flows post announcements and alerts",
    ops: {},
  },
]

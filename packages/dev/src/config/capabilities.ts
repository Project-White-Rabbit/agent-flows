// Every capability an integration can provide. Flows name these, never a
// vendor: "the configured source-control integrations", not "GitHub". To add
// one, list it here and add it to the `provides` of the integrations that fill
// it. Ops are added when a flow first needs them, and every provider must then
// implement them (the registry tests enforce it).

import type { CapabilitySpec } from "./types.ts"

// The fields sync and create-tickets set on an issue beyond its title and
// description. Each tracker maps them to its own: a cycle is a sprint elsewhere.
const ISSUE_FIELDS =
  "priority (`urgent`, `high`, `medium`, `low`), estimate (on the team's scale), labels (names), cycle (`current`: the one in progress, `next`: the one after it, or a `YYYY-MM-DD` date inside one), project (a name), assignee (a person's name or email), and due date (`YYYY-MM-DD`, or `null` to clear it)"

const PR_FIELDS =
  "number, url, title, body, state, whether it's a draft, base and head branches, additions, deletions, and changed-file count"

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
          "Also push branches and open and edit draft pull requests (sync)",
      },
    ],
    defaultLevel: "write",
    ops: {
      prRef:
        "Which arguments name one of this host's pull requests: a bare number, or the host's pull request URL for this repository",
      currentPr: `The open pull request for the checked-out branch: ${PR_FIELDS}. No pull request, or the CLI missing or signed out, means there is none`,
      prMetadata: `Pull request <N>: ${PR_FIELDS}`,
      prDiff: "Pull request <N>'s full unified diff",
      prFiles: "Pull request <N>'s changed file paths, one per line",
      prCommits: "Pull request <N>'s commit subjects, one per line",
      prCreate:
        "Open a draft pull request from the checked-out branch into <base>, titled <title>, with the body in the file <body-file>; prints its URL",
      prEdit:
        "Set pull request <N>'s title to <title> and its body to the file <body-file>, leaving its draft or ready state alone",
      prMergeability:
        "Whether pull request <N> merges cleanly into its base: `clean`, `conflicting`, `behind` (the base moved and the host wants it caught up), or `pending` (the host is still computing it)",
    },
  },
  {
    id: "stacking",
    name: "Stacked PRs",
    purpose: "Stacked branches and pull requests on top of source control",
    ops: {
      parent:
        "The checked-out branch's parent in its stack. Fails when the branch isn't tracked",
      track: "Start tracking the checked-out branch, stacked on <parent>",
      restack:
        "Rebase the checked-out branch onto the latest commit of its parent (the fetched remote trunk, when the parent is trunk), stopping on conflicts",
      continue:
        "Carry on with an interrupted restack once its conflicts are resolved and staged",
      submit:
        "Push the checked-out branch and open its pull request as a draft when it has none, leaving an existing pull request's title, body, and draft or ready state alone",
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
      getIssue: `Issue <ID>: its id, title, URL, workflow state, description, ${ISSUE_FIELDS}, parent issue, and whether a pull request is attached. Not found, or archived, means there is none`,
      findIssue:
        "Open issues anchored to branch <branch>, any assignee: their description has a `> Branch:` line naming it, in backticks or bare (as older tools wrote it), reading an issue id in it that the tracker turned into a link as plain text",
      searchIssues:
        "Issues that may already describe the work in <text>, any assignee: open ones, and ones closed in the last 90 days, ranked by the tracker's own search, each with its id, title, URL, workflow state, description, parent issue, and whether a pull request is attached",
      createIssue: `File an issue titled <title> with the description <description>, assigned to the current user unless <fields> names an assignee, as a sub-issue of <parent> when one is given, with <fields>: whichever of ${ISSUE_FIELDS} the flow sets, leaving out the rest. Prints its id and URL`,
      updateIssue: `Set issue <ID>'s title to <title>, its description to <description>, its workflow state to the one matching <state> (\`todo\`, \`in progress\`, \`in review\`, \`done\`, or \`canceled\`), and <fields> as for createIssue. Anything left out (the title, the description, the state, or a field) stays as it is`,
      linkBlocked:
        "Record that issue <ID> is blocked by issue <blocker>, keeping the relations it already has. Linking a pair that's already linked changes nothing",
      prLink:
        "Where a pull request names issue <ID> so the tracker links the two: a closing form, which also closes the issue when the pull request merges, and a linking-only form, when the tracker tells them apart",
    },
  },
  {
    id: "deployments",
    name: "Deployments",
    purpose: "Preview and production deployments, runtime logs",
    ops: {},
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

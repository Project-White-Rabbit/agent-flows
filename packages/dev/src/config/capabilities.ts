// Every capability an integration can provide. Flows name these, never a
// vendor: "the configured source-control integrations", not "GitHub". To add
// one, list it here and add it to the `provides` of the integrations that fill
// it. Ops are added when a flow first needs them, and every provider must then
// implement them (the registry tests enforce it).

import type { CapabilitySpec } from "./types.ts"

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
      getIssue:
        "Issue <ID>: its id, title, URL, workflow state, and description. Not found, or archived, means there is none",
      findIssue:
        "Open issues whose description contains the exact line <line>, any assignee",
      createIssue:
        "File an issue titled <title> with the description <description>, assigned to the current user; prints its id and URL",
      updateIssue:
        "Set issue <ID>'s title to <title>, its description to <description>, and its workflow state to the one matching <state>: `todo`, `in progress`, `in review`, `done`, or `canceled`",
      prLink:
        "How a pull request names issue <ID> so the tracker links the two",
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

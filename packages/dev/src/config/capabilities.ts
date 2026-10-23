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
    ops: {
      prRef:
        "Which arguments name one of this host's pull requests: a bare number, or the host's pull request URL for this repository",
      currentPr: `The open pull request for the checked-out branch: ${PR_FIELDS}. No pull request, or the CLI missing or signed out, means there is none`,
      prMetadata: `Pull request <N>: ${PR_FIELDS}`,
      prDiff: "Pull request <N>'s full unified diff",
      prFiles: "Pull request <N>'s changed file paths, one per line",
      prCommits: "Pull request <N>'s commit subjects, one per line",
    },
  },
  {
    id: "stacking",
    name: "Stacked PRs",
    purpose: "Stacked branches and pull requests on top of source control",
    ops: {},
  },
  {
    id: "issueTracker",
    name: "Issue tracker",
    purpose: "Tickets: link branches and PRs, file and close issues",
    ops: {},
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
    ops: {},
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

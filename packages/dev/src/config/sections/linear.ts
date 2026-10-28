import {
  assignedIssues,
  fieldOptions,
  findIssue,
  projectIssues,
  recordNotes,
  searchIssues,
} from "../adapters/linear.ts"
import type { IntegrationSpec, SectionValues } from "../types.ts"
import { jiraLinkedKeys } from "./jira.ts"
import { ISSUE_KEY } from "./patterns.ts"

// The GraphQL API, authenticated from the token's variable. Pass variables as
// JSON rather than splicing text into the query.
const GRAPHQL =
  "`POST https://api.linear.app/graphql` (headers `Authorization: {token}`, `Content-Type: application/json`):"

// The fields sync and create-tickets set beyond title and description, as the
// MCP's `save_issue` takes them.
const MCP_FIELDS =
  "`<fields>` as `priority` (`urgent` 1, `high` 2, `medium` 3, `low` 4, `none` 0), `estimate` (a number), `labels` (names), `cycle` (a number: from `list_cycles` with `type: current` for `current` and `type: next` for `next`, and for a date the cycle whose `startsAt` to `endsAt` holds it), `project` (a name), `assignee` (a name or email), and `dueDate` (`YYYY-MM-DD`, or `null`)"

// The same through the API, which takes ids.
const API_FIELDS =
  "`<fields>` as `priority` (`urgent` 1, `high` 2, `medium` 3, `low` 4, `none` 0), `estimate`, `labelIds` (from `issueLabels(filter: { name: { in: <names> } })`), `cycleId` (the team's `activeCycle { id }` for `current`, else from the team's `cycles { nodes { id startsAt endsAt } }`: the first to start after the active one for `next`, the one holding a date), `projectId` (from `projects(filter: { name: { eq: <project> } })`), `assigneeId` (from `users(filter: { or: [{ name: { eqIgnoreCase: <assignee> } }, { displayName: { eqIgnoreCase: <assignee> } }, { email: { eq: <assignee> } }] })`), and `dueDate`"

const STATE_MAP =
  "whose type matches: `todo` → `unstarted`, `in progress` → `started`, `in review` → a `started` state named for review when the team has one (else `started`), `done` → `completed`, `canceled` → `canceled`"

// Key-shaped tokens that aren't ticket prefixes.
const NOT_TEAM_KEYS = new Set(["UTF", "ISO", "ES", "SHA", "RFC", "CVE", "HTTP"])

/**
 * The most common `KEY-123` prefix across branch names and commit subjects, if
 * it shows up often enough to be a ticket convention rather than noise.
 */
export function inferLinearTeamKey(
  texts: string[],
  minHits = 3,
  notLinear: Set<string> = new Set(),
): { key: string; hits: number } | undefined {
  const counts = new Map<string, number>()
  for (const text of texts) {
    for (const match of text.matchAll(/\b([A-Za-z][A-Za-z0-9]{1,6})-\d+\b/g)) {
      const key = match[1].toUpperCase()
      if (!NOT_TEAM_KEYS.has(key) && !notLinear.has(key)) {
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  let best: { key: string; hits: number } | undefined
  for (const [key, hits] of counts) {
    if (!best || hits > best.hits) {
      best = { key, hits }
    }
  }
  return best && best.hits >= minHits ? best : undefined
}

export const linear: IntegrationSpec = {
  path: "integrations.linear",
  name: "Linear",
  purpose: "Tickets: link branches and PRs, file and close issues",
  fields: [
    {
      key: "teamKey",
      description: "Issue key prefix",
      example: "ENG",
      required: true,
      pattern: ISSUE_KEY,
    },
    {
      key: "workspace",
      description: "URL slug in linear.app/<slug>",
      example: "acme",
    },
    {
      key: "project",
      description: "Project new issues go in (its name)",
      example: "Web app",
    },
    {
      key: "priority",
      description:
        "Priority for new issues (urgent, high, medium, low), unless the repo's agent instructions rank work otherwise",
      example: "medium",
    },
    {
      key: "labels",
      type: "string[]",
      description:
        "Labels sync picks one of for each issue, by the kind of work",
      example: ["Feature", "Bug", "Improvement"],
    },
    {
      key: "estimate",
      type: "boolean",
      description: "Estimate each issue on the team's scale",
      example: true,
    },
    {
      key: "cycle",
      type: "boolean",
      description: "Put new issues in the current cycle",
      example: true,
    },
    {
      key: "mention",
      description:
        "For a workspace other products share, searched read-only (`use` at `link`): only issues whose title or project names this count",
      example: "Acme",
    },
  ],
  multiple: true,
  lookup:
    "Linear MCP (`list_teams`; `list_projects` for the team's projects), or the API's `teams` and `projects` queries",
  access: {
    mcp: { server: "Linear" },
    api: { base: "https://api.linear.app/graphql", token: ["LINEAR_API_KEY"] },
  },
  adapters: {
    findIssue,
    searchIssues,
    assignedIssues,
    projectIssues,
    fieldOptions,
    recordNotes,
  },
  provides: {
    issueTracker: {
      issueRef:
        "`{teamKey}-<n>` in any case, or a `https://linear.app/<workspace>/issue/{teamKey}-<n>` URL",
      getIssue: {
        mcp: "The Linear MCP's `get_issue` with `id: <ID>` and `fields` including `priority`, `estimate`, `labels`, `cycleId`, `project`, `assignee`, `dueDate`, `parentId`, `attachments` (a pull request is one whose URL is a pull request's), and `gitBranchName` (the branch it suggests); its cycle's start from `list_cycles`, and its open sub-issues from `list_issues` with `parentId: <ID>` (open: not in a completed or canceled state)",
        api: `${GRAPHQL} \`issue(id: "<ID>") { identifier title url description archivedAt state { name type } priority estimate labels { nodes { name } } cycle { number startsAt } project { name } assignee { name } dueDate parent { identifier } children(filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { identifier title priority dueDate cycle { number startsAt } } } attachments { nodes { url } } branchName }\`; \`branchName\` is the branch it suggests, and \`children\` its open sub-issues`,
      },
      // Also an adapter (`adapters/linear.ts`), which sync runs first: the
      // API's `contains` filter is exact, where the MCP's `query` is a fuzzy,
      // paginated search.
      findIssue: {
        mcp: "The Linear MCP's `list_issues` with `team: {teamKey}`, `query: <branch>`, `includeArchived: false`, and `limit: 250`, once per open state type (`triage`, `backlog`, `unstarted`, `started`), following `cursor` until `hasNextPage` is false: its `query` is a fuzzy search, so a match can be on any page. Keep only issues whose description has a `> Branch:` line that is `<branch>` once backticks are dropped and any `[text](url)` or `<issue>` link is read as its text, ignoring the case of issue ids",
      },
      // Also an adapter, which ranks with the API's semantic search.
      searchIssues: {
        mcp: "The Linear MCP's `list_issues` with `team: {teamKey}`, `query: <text>`, and `limit: 10`: once with no state (open issues), once with `state: completed` and once with `state: canceled`, each with `updatedAt: -P90D`. Ask for `fields` `title`, `url`, `status`, `statusType`, `description`, `project`, and `parentId`; load a candidate with `get_issue` to see whether a pull request is attached. Then try two or three shorter queries from the text's key words, since `query` matches words, not meaning. When the entry's `values` set `mention`, keep only issues whose title or project contains it (any case)",
      },
      // Also adapters, which read every page, or every list, in one call.
      projectIssues: {
        mcp: "The Linear MCP's `list_issues` with `team: {teamKey}`, `project: <project>`, `includeArchived: false`, and `limit: 250`, once per open state type (`triage`, `backlog`, `unstarted`, `started`), following `cursor` until `hasNextPage` is false, with `fields` `title`, `url`, `status`, `priority`, `dueDate`, and `parentId`",
      },
      fieldOptions: {
        mcp: "The Linear MCP's `list_users` (active people: `name`, `displayName`, `email`), `list_projects` with `team: {teamKey}` (not completed or canceled), `list_issue_labels` with `team: {teamKey}`, and `list_cycles` with `teamId` the team's and `type: current`, then `type: next` and later ones (each cycle's `number` as `id`, `startsAt`, `endsAt`)",
      },
      // The cycle's document; the MCP can't place one in a cycle, so it goes
      // in the team when the adapter can't run.
      recordNotes: {
        mcp: "The Linear MCP's `list_documents` with `query: <title>` for one titled exactly <title>; when there is one, `get_document` for its `content`, replace its `## ` section whose `Source:` line contains <key> with the text of <section-file> (or add that text at the end, after a blank line), and `save_document` with its `id` and the new `content`. When there's none, `save_document` with `title: <title>`, `content` the file's text, and the team {teamKey}. Print its title and `url`",
      },
      assignedIssues: {
        mcp: "The Linear MCP's `list_issues` with `team: {teamKey}`, `assignee: \"me\"`, `includeArchived: false`, and `limit: 250`, once per open state type (`triage`, `backlog`, `unstarted`, `started`), following `cursor` until `hasNextPage` is false. Then load each with `get_issue` for its sub-issues (open ones are in an open state type), its `attachments` (a pull request is one whose URL is a pull request's), and its relations (it blocks another issue through a `blocks` relation to an open one)",
        api: `${GRAPHQL} \`viewer { assignedIssues(first: 100, after: <cursor>, filter: { team: { key: { eq: "{teamKey}" } }, state: { type: { in: ["triage", "backlog", "unstarted", "started"] } } }) { nodes { identifier title url description priority dueDate state { name type } children { nodes { state { type } } } attachments { nodes { url } } relations { nodes { type relatedIssue { state { type } } } } } pageInfo { hasNextPage endCursor } } }\`, following \`endCursor\` until \`hasNextPage\` is false. \`priority\` is 0 for none, 1 urgent, 2 high, 3 medium, 4 low; open sub-issues and blocked issues are in an open state type`,
      },
      createIssue: {
        mcp: `The Linear MCP's \`save_issue\` with \`team: {teamKey}\`, \`title\`, \`description\`, \`assignee: "me"\` (unless \`<fields>\` names one), \`parentId: <parent>\` when given, \`state\` for <state> when given (as for \`updateIssue\`; \`todo\` is the team's state named Todo when it has one), and ${MCP_FIELDS}`,
        api: `${GRAPHQL} \`issueCreate(input: { teamId, title, description, assigneeId, parentId, stateId })\` with ${API_FIELDS}; \`teamId\` from \`teams(filter: { key: { eq: "{teamKey}" } })\`, \`assigneeId\` from \`viewer { id }\` (unless \`<fields>\` names an assignee), \`parentId\` the id of \`issue(id: "<parent>")\` when given, and \`stateId\` for <state> when given, as for \`updateIssue\` (\`todo\`: the state named Todo when there is one). It returns \`issue { identifier url }\``,
      },
      updateIssue: {
        mcp: `The Linear MCP's \`save_issue\` with \`id\`, \`title\`, \`description\`, \`parentId: <parent>\`, \`state\`: the team's workflow state (\`list_issue_statuses\`) ${STATE_MAP}, and ${MCP_FIELDS}. For a label change, pass \`addLabels\` with the new label and \`removeLabels\` with the one it replaces, never \`labels\`, which replaces every label the issue has`,
        api: `${GRAPHQL} \`issueUpdate(id: "<ID>", input: { title, description, stateId, parentId })\` with ${API_FIELDS}, \`parentId\` the id of \`issue(id: "<parent>")\`, and \`stateId\` the team's workflow state (\`workflowStates(filter: { team: { key: { eq: "{teamKey}" } } })\`) ${STATE_MAP}. For a label change, pass \`addedLabelIds\` with the new label and \`removedLabelIds\` with the one it replaces, never \`labelIds\`, which replaces every label the issue has`,
      },
      linkBlocked: {
        mcp: "The Linear MCP's `save_issue` with `id: <ID>` and `blockedBy: [<blocker>]`, which adds to the relations the issue already has",
        api: `${GRAPHQL} \`issueRelationCreate(input: { issueId, relatedIssueId, type: blocks })\` with \`issueId\` the id of \`issue(id: "<blocker>")\` and \`relatedIssueId\` the id of \`issue(id: "<ID>")\`. Skip it when \`issue(id: "<ID>") { inverseRelations { nodes { type issue { identifier } } } }\` already has a \`blocks\` relation from \`<blocker>\``,
      },
      prLink:
        "Closing: a `Fixes <ID>` line in the pull request body, which also moves the issue to done when the pull request merges. Linking only: a `Part of <ID>` line in the body. Either way the title can stay as the repo writes it",
    },
  },
  detect(ctx) {
    const refs = (
      ctx.git([
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
      ]) ?? ""
    ).split("\n")
    const subjects = (ctx.git(["log", "-300", "--format=%s"]) ?? "").split("\n")
    const evidence = ctx.dependsOn(/^@linear\//)
    // Keys the team links to Jira are Jira's, however often they show up.
    const jiraKeys = jiraLinkedKeys(
      (ctx.git(["log", "-300", "--format=%B"]) ?? "").split("\n"),
    )
    const team = inferLinearTeamKey([...refs, ...subjects], 3, jiraKeys)
    if (team) {
      evidence.unshift(
        `${team.hits} branch names or commit subjects reference ${team.key}-<n>`,
      )
    }
    const values: SectionValues = team ? { teamKey: team.key } : {}
    return evidence.length > 0 ? { values, evidence } : undefined
  },
}

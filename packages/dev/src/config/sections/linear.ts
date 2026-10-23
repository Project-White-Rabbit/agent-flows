import type { IntegrationSpec, SectionValues } from "../types.ts"
import { jiraLinkedKeys } from "./jira.ts"
import { ISSUE_KEY } from "./patterns.ts"

// The GraphQL API, authenticated from the token's variable. Pass variables as
// JSON rather than splicing text into the query.
const GRAPHQL =
  "`POST https://api.linear.app/graphql` (headers `Authorization: {token}`, `Content-Type: application/json`):"

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
  ],
  multiple: true,
  lookup: "Linear MCP (list teams), or the API's `teams` query",
  access: {
    mcp: { server: "Linear" },
    api: { base: "https://api.linear.app/graphql", token: ["LINEAR_API_KEY"] },
  },
  provides: {
    issueTracker: {
      issueRef:
        "`{teamKey}-<n>` in any case, or a `https://linear.app/<workspace>/issue/{teamKey}-<n>` URL",
      getIssue: {
        mcp: "The Linear MCP's `get_issue` with `id: <ID>`",
        api: `${GRAPHQL} \`issue(id: "<ID>") { identifier title url description archivedAt state { name type } }\``,
      },
      findIssue: {
        mcp: "The Linear MCP's `list_issues` with `team: {teamKey}`, `query: <line>`, and `includeArchived: false`, once per open state type (`backlog`, `unstarted`, `started`); keep only issues whose description has exactly that line",
        api: `${GRAPHQL} \`issues(filter: { team: { key: { eq: "{teamKey}" } }, state: { type: { in: ["backlog", "unstarted", "started"] } }, description: { contains: <line as a JSON string> } }) { nodes { identifier title url description updatedAt } }\`; keep only issues whose description has exactly that line`,
      },
      createIssue: {
        mcp: 'The Linear MCP\'s `save_issue` with `team: {teamKey}`, `title`, `description`, and `assignee: "me"`',
        api: `${GRAPHQL} \`issueCreate(input: { teamId, title, description, assigneeId })\`, with \`teamId\` from \`teams(filter: { key: { eq: "{teamKey}" } })\` and \`assigneeId\` from \`viewer { id }\`; it returns \`issue { identifier url }\``,
      },
      updateIssue: {
        mcp: `The Linear MCP's \`save_issue\` with \`id\`, \`title\`, \`description\`, and \`state\`: the team's workflow state (\`list_issue_statuses\`) ${STATE_MAP}`,
        api: `${GRAPHQL} \`issueUpdate(id: "<ID>", input: { title, description, stateId })\`, with \`stateId\` the team's workflow state (\`workflowStates(filter: { team: { key: { eq: "{teamKey}" } } })\`) ${STATE_MAP}`,
      },
      prLink:
        "Start the pull request title with `<ID>: `; Linear's source-control integration links it",
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

import type { IntegrationSpec, SectionValues } from "../types.ts"
import { HOST, ISSUE_KEY } from "./patterns.ts"

// The REST API with basic auth: the account's email and an API token.
const AUTH = 'basic auth `"$JIRA_EMAIL:{token}"`'
const REST = '`curl -fsSL -u "$JIRA_EMAIL:{token}" "https://{site}/rest/api/3'
const JQL =
  '`project = {projectKey} AND statusCategory != Done AND text ~ "<line>"`'
const TRANSITION =
  "whose status category matches: `todo` → To Do, `in progress` and `in review` → In Progress (a status named for review when there is one), `done` and `canceled` → Done. Skip the transition when the issue is already there"

const BROWSE_LINK =
  /\b([a-z0-9-]+\.atlassian\.net)\/browse\/([A-Z][A-Z0-9_]+)-\d+/g

/** Every project key a `<site>.atlassian.net/browse/KEY-123` link names. */
export function jiraLinkedKeys(texts: string[]): Set<string> {
  return new Set(
    texts.flatMap((text) => [...text.matchAll(BROWSE_LINK)].map((m) => m[2])),
  )
}

/**
 * The most common `<site>.atlassian.net/browse/KEY-123` link across commit
 * messages: the Jira site and project the team links work to.
 */
export function inferJiraProject(
  texts: string[],
): { site: string; projectKey: string; hits: number } | undefined {
  const counts = new Map<string, number>()
  for (const text of texts) {
    for (const match of text.matchAll(BROWSE_LINK)) {
      const key = `${match[1]} ${match[2]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let best: { site: string; projectKey: string; hits: number } | undefined
  for (const [key, hits] of counts) {
    if (!best || hits > best.hits) {
      const [site, projectKey] = key.split(" ")
      best = { site, projectKey, hits }
    }
  }
  return best
}

export const jira: IntegrationSpec = {
  path: "integrations.jira",
  name: "Jira",
  purpose: "Tickets: link branches and PRs, file and close issues",
  fields: [
    {
      key: "site",
      description: "Atlassian site host",
      example: "acme.atlassian.net",
      required: true,
      pattern: HOST,
    },
    {
      key: "projectKey",
      description: "Issue key prefix",
      example: "ENG",
      required: true,
      pattern: ISSUE_KEY,
    },
  ],
  multiple: true,
  lookup: "Atlassian MCP (list projects), the API's `project/search`, or ask",
  access: {
    mcp: { server: "Atlassian" },
    api: {
      base: "https://<site>/rest/api/3, basic auth with `JIRA_EMAIL`",
      token: ["JIRA_API_TOKEN"],
    },
  },
  provides: {
    issueTracker: {
      issueRef:
        "`{projectKey}-<n>`, or `https://{site}/browse/{projectKey}-<n>`",
      getIssue: {
        mcp: "The Atlassian MCP's `getJiraIssue` for `<ID>` on `{site}`; its URL is `https://{site}/browse/<ID>`",
        api: `${REST}/issue/<ID>?fields=summary,description,status"\`; its URL is \`https://{site}/browse/<ID>\``,
      },
      findIssue: {
        mcp: `The Atlassian MCP's \`searchJiraIssuesUsingJql\` on \`{site}\` with ${JQL}; keep only issues whose description has exactly that line`,
        api: `\`POST https://{site}/rest/api/3/search/jql\` (${AUTH}) with JSON \`jql\` ${JQL} and \`fields: ["summary", "description", "updated"]\`; keep only issues whose description has exactly that line`,
      },
      createIssue: {
        mcp: "The Atlassian MCP's `createJiraIssue` on `{site}` in project `{projectKey}`, issue type `Task`, assigned to the current user (`atlassianUserInfo`)",
        api: `\`POST https://{site}/rest/api/3/issue\` (${AUTH}) with \`fields\`: \`project.key\` \`{projectKey}\`, \`issuetype.name\` \`Task\`, \`summary\`, \`description\` (Atlassian Document Format), and \`assignee.accountId\` from \`GET /rest/api/3/myself\``,
      },
      updateIssue: {
        mcp: `The Atlassian MCP's \`editJiraIssue\` on \`{site}\` for the summary and description, then \`transitionJiraIssue\` to the transition (\`getTransitionsForJiraIssue\`) ${TRANSITION}`,
        api: `\`PUT https://{site}/rest/api/3/issue/<ID>\` (${AUTH}) with \`fields.summary\` and \`fields.description\` (Atlassian Document Format), then \`POST .../issue/<ID>/transitions\` with the transition (\`GET .../issue/<ID>/transitions\`) ${TRANSITION}`,
      },
      prLink:
        "Start the pull request title with `<ID>: `; Jira's development panel links it",
    },
  },
  detect(ctx) {
    const messages = (ctx.git(["log", "-300", "--format=%B"]) ?? "").split("\n")
    const evidence = ctx.dependsOn(/^(jira-client|jira\.js|jira)$/)
    const project = inferJiraProject(messages)
    let values: SectionValues = {}
    if (project) {
      evidence.unshift(
        `${project.hits} commit message(s) link ${project.site}/browse/${project.projectKey}-<n>`,
      )
      values = { site: project.site, projectKey: project.projectKey }
    }
    return evidence.length > 0 ? { values, evidence } : undefined
  },
}

import type { IntegrationSpec, SectionValues } from "../types.ts"
import { HOST, ISSUE_KEY } from "./patterns.ts"

// The REST API with basic auth: the account's email and an API token.
const AUTH = 'basic auth `"$JIRA_EMAIL:{token}"`'
const REST = '`curl -fsSL -u "$JIRA_EMAIL:{token}" "https://{site}/rest/api/3'
const JQL =
  '`project = {projectKey} AND statusCategory != Done AND text ~ "<branch>"`'
const SEARCH_JQL =
  '`project = {projectKey} AND text ~ "<text>" AND (statusCategory != Done OR resolved >= -90d) ORDER BY relevance`'
const ASSIGNED_JQL =
  "`project = {projectKey} AND assignee = currentUser() AND statusCategory != Done`"
const ASSIGNED_FIELDS =
  "`summary`, `status`, `description`, `priority`, `duedate`, `subtasks`, and `issuelinks` (it blocks another issue through a `Blocks` link whose outward issue isn't done)"
// Keep only issues anchored to the branch, however the line was written.
const BRANCH_MATCH =
  "Keep only issues whose description has a `> Branch:` line that is `<branch>` once backticks are dropped and any link is read as its text"
// The fields sync and create-tickets set beyond summary and description.
const FIELDS =
  "`<fields>` as `priority.name` (`Highest` for urgent, `High`, `Medium`, `Low`; leave it out for `none`, so the project's default applies), `labels`, the story points field for `estimate` when the project has one, the board's sprint for `cycle` when it has one (Jira Software: the active sprint for `current`, the next future one for `next`, the one whose dates hold a date), `assignee.accountId` for `assignee` (from the user search for the name or email), and `duedate`. `project` doesn't apply: the project is `{projectKey}`"
const FIELD_NAMES =
  "`priority`, `labels`, `assignee`, `duedate`, `parent`, `subtasks`, `issuelinks`, the story points field, and the sprint field (its `startDate` is when the issue's cycle starts); its open sub-issues are the `subtasks` whose status category isn't Done, each loaded for its priority, due date, and sprint"
// Setting `labels` replaces them all, so a label change adds and removes.
const LABEL_UPDATE =
  'for a label change, leave `labels` out and pass `update.labels` as `[{ "add": <new> }, { "remove": <old> }]`, so the issue keeps its other labels'
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
      example: ["feature", "bug", "improvement"],
    },
    {
      key: "estimate",
      type: "boolean",
      description: "Estimate each issue in story points",
      example: true,
    },
    {
      key: "cycle",
      type: "boolean",
      description: "Put new issues in the board's active sprint",
      example: true,
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
        mcp: `The Atlassian MCP's \`getJiraIssue\` for \`<ID>\` on \`{site}\`, with ${FIELD_NAMES}; its URL is \`https://{site}/browse/<ID>\`, and a pull request shows in its development panel`,
        api: `${REST}/issue/<ID>?fields=summary,description,status,priority,labels,assignee,duedate,parent,subtasks,issuelinks,*navigable"\` (${FIELD_NAMES}); its URL is \`https://{site}/browse/<ID>\`, and a pull request shows in \`GET /rest/dev-status/latest/issue/summary?issueId=<numeric id>\``,
      },
      findIssue: {
        mcp: `The Atlassian MCP's \`searchJiraIssuesUsingJql\` on \`{site}\` with ${JQL}, following \`nextPageToken\` to the last page: \`text ~\` is a fuzzy search, so a match can be on any page. ${BRANCH_MATCH}`,
        api: `\`POST https://{site}/rest/api/3/search/jql\` (${AUTH}) with JSON \`jql\` ${JQL} and \`fields: ["summary", "description", "updated"]\`, following \`nextPageToken\` to the last page (\`text ~\` is fuzzy). ${BRANCH_MATCH}`,
      },
      searchIssues: {
        mcp: `The Atlassian MCP's \`searchJiraIssuesUsingJql\` on \`{site}\` with ${SEARCH_JQL}, \`maxResults: 10\`, and fields \`summary\`, \`status\`, \`description\`, and \`parent\`. Then try two or three shorter queries from the text's key words, since \`text ~\` matches words, not meaning`,
        api: `\`POST https://{site}/rest/api/3/search/jql\` (${AUTH}) with JSON \`jql\` ${SEARCH_JQL}, \`maxResults: 10\`, and \`fields: ["summary", "status", "description", "parent"]\`. Then try two or three shorter queries from the text's key words`,
      },
      assignedIssues: {
        mcp: `The Atlassian MCP's \`searchJiraIssuesUsingJql\` on \`{site}\` with ${ASSIGNED_JQL} and fields ${ASSIGNED_FIELDS}, following \`nextPageToken\` to the last page. Its URL is \`https://{site}/browse/<ID>\`, an open sub-issue is a subtask whose status isn't done, and a pull request shows in its development panel`,
        api: `\`POST https://{site}/rest/api/3/search/jql\` (${AUTH}) with JSON \`jql\` ${ASSIGNED_JQL} and \`fields\` ${ASSIGNED_FIELDS}, following \`nextPageToken\` to the last page. Its URL is \`https://{site}/browse/<ID>\`, an open sub-issue is a subtask whose status isn't done, and a pull request shows in \`GET /rest/dev-status/latest/issue/summary?issueId=<numeric id>\``,
      },
      createIssue: {
        mcp: `The Atlassian MCP's \`createJiraIssue\` on \`{site}\` in project \`{projectKey}\`, issue type \`Task\` (\`Subtask\` with \`parent\` set to \`<parent>\`, when given), assigned to the current user (\`atlassianUserInfo\`) unless \`<fields>\` names an assignee, with ${FIELDS}. With <state>, then \`transitionJiraIssue\` as for \`updateIssue\``,
        api: `\`POST https://{site}/rest/api/3/issue\` (${AUTH}) with \`fields\`: \`project.key\` \`{projectKey}\`, \`issuetype.name\` \`Task\` (\`Subtask\`, with \`parent.key\` \`<parent>\`, when given), \`summary\`, \`description\` (Atlassian Document Format), \`assignee.accountId\` from \`GET /rest/api/3/myself\` unless \`<fields>\` names an assignee, and ${FIELDS}. With <state>, then its transition as for \`updateIssue\``,
      },
      updateIssue: {
        mcp: `The Atlassian MCP's \`editJiraIssue\` on \`{site}\` for the summary, the description, \`parent\` (\`{ "key": <parent> }\`), and ${FIELDS} (${LABEL_UPDATE}), then \`transitionJiraIssue\` to the transition (\`getTransitionsForJiraIssue\`) ${TRANSITION}`,
        api: `\`PUT https://{site}/rest/api/3/issue/<ID>\` (${AUTH}) with \`fields.summary\`, \`fields.description\` (Atlassian Document Format), \`fields.parent.key\` <parent> (a sub-task moves only between parents its issue type allows; when Jira refuses, say so), and ${FIELDS} (${LABEL_UPDATE}), then \`POST .../issue/<ID>/transitions\` with the transition (\`GET .../issue/<ID>/transitions\`) ${TRANSITION}`,
      },
      projectIssues: {
        unsupported:
          "A Jira entry is one project ({projectKey}), so there's no project to narrow to: searchIssues covers it",
      },
      fieldOptions: {
        api: `\`GET https://{site}/rest/api/3/user/assignable/search?project={projectKey}&maxResults=1000\` (${AUTH}) for the people (\`displayName\` as \`name\`, \`emailAddress\` as \`email\`, when visible), \`GET .../rest/api/3/label?maxResults=1000\` for the labels (\`values\`, following \`startAt\` while \`isLast\` is false), and, on Jira Software, \`GET https://{site}/rest/agile/1.0/board?projectKeyOrId={projectKey}\` for its board, then \`GET .../rest/agile/1.0/board/<board id>/sprint?state=active,future\` for the cycles (\`name\` as \`id\`, \`startDate\` and \`endDate\` as \`startsAt\` and \`endsAt\`, \`current\` for the active one; a future sprint with no dates yet is left out). No \`projects\`: the project is {projectKey}`,
        mcp: "The Atlassian MCP has no tools for a project's labels or sprints: use the API variant, or, when it can't run, `lookupJiraAccountId` for each person the plan names and leave the rest unchecked",
      },
      recordNotes: {
        unsupported:
          "Jira has no planning document for a sprint, and Confluence isn't part of this integration",
      },
      // Jira reads a Blocks link's inwardIssue as the one that blocks.
      linkBlocked: {
        mcp: "The Atlassian MCP's `createIssueLink` on `{site}` with type `Blocks`, `inwardIssue` `<blocker>`, and `outwardIssue` `<ID>`, unless `<ID>`'s `issuelinks` already say it is blocked by `<blocker>`. Afterwards `<ID>` must read \"is blocked by <blocker>\"; when it reads the other way, delete the link and swap the two",
        api: `\`POST https://{site}/rest/api/3/issueLink\` (${AUTH}) with JSON \`{"type": {"name": "Blocks"}, "inwardIssue": {"key": "<blocker>"}, "outwardIssue": {"key": "<ID>"}}\`, unless \`<ID>\`'s \`issuelinks\` already say it is blocked by \`<blocker>\`. Afterwards \`<ID>\` must read "is blocked by <blocker>"; when it reads the other way, delete the link and swap the two`,
      },
      prLink:
        "Jira's development panel reads the issue key from the pull request title, branch name, or commit messages, not the body, so when the branch name doesn't carry `<ID>`, the title must: prefix it (`<ID> `) and keep the rest of the repo's title convention. Merging doesn't close it",
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

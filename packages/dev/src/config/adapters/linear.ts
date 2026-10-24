// Linear ops as code. findIssue and searchIssues need it: the MCP's search is
// fuzzy and paginated, while the API filters descriptions exactly and ranks
// issues by meaning with its own search.
//
// Runtime code: Node built-ins only.

import type { Adapter, AdapterInput } from "../types.ts"

const GRAPHQL = "https://api.linear.app/graphql"

const OPEN_STATES = ["triage", "backlog", "unstarted", "started"]

/** How far back searchIssues looks at closed issues. */
export const CLOSED_LOOKBACK_DAYS = 90

/** How many issues searchIssues returns, best first. */
const SEARCH_RESULTS = 10

/** Linear's search takes a short term; a title-sized one ranks best. */
const MAX_SEARCH_TERM = 300

/** Enough of a description to judge whether it's the same work. */
const MAX_DESCRIPTION = 1500

const FIND_ISSUES = `
query FindIssue($team: String!, $anchors: [IssueFilter!]!, $after: String) {
  issues(
    first: 100
    after: $after
    orderBy: updatedAt
    filter: {
      team: { key: { eq: $team } }
      state: { type: { in: ["triage", "backlog", "unstarted", "started"] } }
      or: $anchors
    }
  ) {
    nodes { identifier title url description updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`

const SEARCH_ISSUES = `
query SearchIssues($term: String!, $first: Int!, $filter: IssueFilter) {
  searchIssues(term: $term, first: $first, filter: $filter) {
    nodes {
      identifier title url description
      state { name type }
      parent { identifier title }
      attachments { nodes { url } }
    }
  }
}`

type IssueNode = {
  identifier: string
  title: string
  url: string
  description?: string | null
  updatedAt: string
}

type SearchNode = {
  identifier: string
  title: string
  url: string
  description?: string | null
  state: { name: string; type: string }
  parent?: { identifier: string; title: string } | null
  attachments?: { nodes: { url: string }[] }
}

async function graphql<T>(
  input: AdapterInput,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await input.fetch(GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: input.token ?? "",
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) {
    throw new Error(`Linear API returned HTTP ${response.status}`)
  }
  const body = (await response.json()) as {
    data?: T
    errors?: { message: string }[]
  }
  if (body.errors?.length) {
    throw new Error(
      `Linear API: ${body.errors.map((e) => e.message).join("; ")}`,
    )
  }
  return body.data as T
}

const BRANCH_LINE = /^> Branch:\s*(.+?)\s*$/
const ISSUE_ID = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-\d+)(?![A-Za-z0-9])/g

/**
 * A branch as written in a `> Branch:` line, compared loosely: without the
 * backticks sync writes, with any issue id the tracker turned into a link
 * (`[HVT-1](https://…)`, or `<issue …>HVT-1</issue>` from the MCP) read as its
 * text, and with issue ids in one case, since a link shows the id uppercased.
 */
export function normalizeBranch(text: string): string {
  const plain = text
    .trim()
    .replace(/^`(.*)`$/, "$1")
    .replace(/<issue\b[^>]*>(.*?)<\/issue>/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  return plain.replace(ISSUE_ID, (id) => id.toLowerCase())
}

/** Whether `description` has a `> Branch:` line naming `branch`. */
export function hasBranchLine(description: string, branch: string): boolean {
  const want = normalizeBranch(branch)
  return description.split("\n").some((line) => {
    const found = line.trim().match(BRANCH_LINE)
    return found !== null && normalizeBranch(found[1]) === want
  })
}

/**
 * Server-side filters that catch every way a `> Branch:` line for `branch` is
 * stored: with backticks (sync), bare (older tools), and with an issue id
 * turned into a link, up to that link. `hasBranchLine` then keeps exact ones.
 */
export function branchAnchors(branch: string): Record<string, unknown>[] {
  const anchors: Record<string, unknown>[] = [
    { description: { contains: `> Branch: \`${branch}\`` } },
    { description: { contains: `> Branch: ${branch}` } },
  ]
  const id = [...branch.matchAll(ISSUE_ID)][0]
  if (id?.index !== undefined) {
    const linked = `> Branch: ${branch.slice(0, id.index)}[${id[1]}](`
    anchors.push({ description: { containsIgnoreCase: linked } })
  }
  return anchors
}

export const findIssue: Adapter = {
  needs: "api",
  args: ["branch"],
  async run(input) {
    const branch = input.args.branch?.trim()
    if (!branch) {
      throw new Error("findIssue needs --branch <branch>")
    }
    const matches: IssueNode[] = []
    let after: string | undefined
    // The filters narrow on the server; the exact check keeps "foo" from
    // matching an issue anchored to "foo-bar".
    do {
      const data = await graphql<{
        issues: {
          nodes: IssueNode[]
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      }>(input, FIND_ISSUES, {
        team: input.values.teamKey,
        anchors: branchAnchors(branch),
        after,
      })
      matches.push(
        ...data.issues.nodes.filter((n) =>
          hasBranchLine(n.description ?? "", branch),
        ),
      )
      after = data.issues.pageInfo.hasNextPage
        ? (data.issues.pageInfo.endCursor ?? undefined)
        : undefined
    } while (after)
    matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return {
      issues: matches.map(({ identifier, title, url, updatedAt }) => ({
        identifier,
        title,
        url,
        updatedAt,
      })),
    }
  },
}

/** Attachments that are pull or merge requests. */
function pullRequests(node: SearchNode): string[] {
  return (node.attachments?.nodes ?? [])
    .map((a) => a.url)
    .filter((url) => /\/(pull|merge_requests)\/\d+/.test(url))
}

export const searchIssues: Adapter = {
  needs: "api",
  args: ["text"],
  async run(input) {
    const text = input.args.text?.trim()
    if (!text) {
      throw new Error("searchIssues needs --text <text>")
    }
    const since = new Date(
      Date.now() - CLOSED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString()
    const data = await graphql<{ searchIssues: { nodes: SearchNode[] } }>(
      input,
      SEARCH_ISSUES,
      {
        term: text.slice(0, MAX_SEARCH_TERM),
        first: SEARCH_RESULTS,
        filter: {
          team: { key: { eq: input.values.teamKey } },
          or: [
            { state: { type: { in: OPEN_STATES } } },
            { completedAt: { gt: since } },
            { canceledAt: { gt: since } },
          ],
        },
      },
    )
    return {
      issues: data.searchIssues.nodes.map((node) => ({
        identifier: node.identifier,
        title: node.title,
        url: node.url,
        state: node.state.name,
        open: OPEN_STATES.includes(node.state.type),
        parent: node.parent?.identifier ?? null,
        pullRequests: pullRequests(node),
        description: (node.description ?? "").slice(0, MAX_DESCRIPTION),
      })),
    }
  },
}

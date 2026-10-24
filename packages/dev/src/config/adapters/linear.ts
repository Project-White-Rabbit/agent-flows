// Linear ops as code. findIssue is the one that needs it: the MCP's search is
// fuzzy and paginated, while the API filters descriptions exactly.
//
// Runtime code: Node built-ins only.

import type { Adapter, AdapterInput } from "../types.ts"

const GRAPHQL = "https://api.linear.app/graphql"

const FIND_ISSUES = `
query FindIssue($team: String!, $line: String!, $after: String) {
  issues(
    first: 100
    after: $after
    orderBy: updatedAt
    filter: {
      team: { key: { eq: $team } }
      state: { type: { in: ["backlog", "unstarted", "started"] } }
      description: { contains: $line }
    }
  ) {
    nodes { identifier title url description updatedAt }
    pageInfo { hasNextPage endCursor }
  }
}`

type IssueNode = {
  identifier: string
  title: string
  url: string
  description?: string | null
  updatedAt: string
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

/** Whether `description` has `line` as a whole line, ignoring outer spaces. */
export function hasLine(description: string, line: string): boolean {
  const want = line.trim()
  return description.split("\n").some((l) => l.trim() === want)
}

export const findIssue: Adapter = {
  needs: "api",
  args: ["line"],
  async run(input) {
    const line = input.args.line
    if (!line) {
      throw new Error("findIssue needs --line <line>")
    }
    const matches: IssueNode[] = []
    let after: string | undefined
    // `contains` narrows on the server; the exact-line check keeps "foo" from
    // matching an issue anchored to "foo-bar".
    do {
      const data = await graphql<{
        issues: {
          nodes: IssueNode[]
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      }>(input, FIND_ISSUES, {
        team: input.values.teamKey,
        line: line.trim(),
        after,
      })
      matches.push(
        ...data.issues.nodes.filter((n) => hasLine(n.description ?? "", line)),
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

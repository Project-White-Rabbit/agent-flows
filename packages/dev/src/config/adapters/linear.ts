// Linear ops as code. findIssue and searchIssues need it: the MCP's search is
// fuzzy and paginated, while the API filters descriptions exactly and ranks
// issues by meaning with its own search. assignedIssues and projectIssues read
// every page in one call; fieldOptions reads the team's people, projects,
// labels, and cycles at once; recordNotes finds or makes the cycle's planning
// document and replaces one section of it.
//
// Runtime code: Node built-ins only.

import fs from "node:fs"
import { hasBranchLine, ISSUE_ID } from "../branch-line.ts"
import { upsertSection } from "../planning.ts"
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

const ASSIGNED_ISSUES = `
query AssignedIssues($team: String!, $after: String) {
  viewer {
    assignedIssues(
      first: 100
      after: $after
      filter: {
        team: { key: { eq: $team } }
        state: { type: { in: ["triage", "backlog", "unstarted", "started"] } }
      }
    ) {
      nodes {
        identifier title url description priority dueDate
        state { name type }
        children { nodes { state { type } } }
        attachments { nodes { url } }
        relations { nodes { type relatedIssue { state { type } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

const PROJECT_ISSUES = `
query ProjectIssues($team: String!, $project: String!, $after: String) {
  issues(
    first: 100
    after: $after
    filter: {
      team: { key: { eq: $team } }
      project: { name: { eqIgnoreCase: $project } }
      state: { type: { in: ["triage", "backlog", "unstarted", "started"] } }
    }
  ) {
    nodes {
      identifier title url priority dueDate
      state { name }
      parent { identifier }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

const FIELD_OPTIONS = `
query FieldOptions($team: String!, $now: DateTimeOrDuration!) {
  teams(first: 1, filter: { key: { eq: $team } }) {
    nodes {
      members(first: 250) { nodes { name displayName email active } }
      projects(first: 250, filter: { state: { nin: ["completed", "canceled"] } }) {
        nodes { name }
      }
      activeCycle { number }
      cycles(first: 50, filter: { endsAt: { gt: $now } }) {
        nodes { number name startsAt endsAt }
      }
    }
  }
  issueLabels(
    first: 250
    filter: { or: [{ team: { key: { eq: $team } } }, { team: { null: true } }] }
  ) {
    nodes { name }
  }
}`

const PLANNING_PLACE = `
query PlanningPlace($team: String!, $title: String!) {
  teams(first: 1, filter: { key: { eq: $team } }) {
    nodes {
      id
      activeCycle { id documents(first: 50) { nodes { id title url } } }
    }
  }
  documents(first: 1, filter: { title: { eq: $title } }) {
    nodes { id title url }
  }
}`

const DOCUMENT = `
query Document($id: String!) { document(id: $id) { id title url content } }`

const DOCUMENT_UPDATE = `
mutation DocumentUpdate($id: String!, $content: String!) {
  documentUpdate(id: $id, input: { content: $content }) {
    document { title url }
  }
}`

const DOCUMENT_CREATE = `
mutation DocumentCreate($input: DocumentCreateInput!) {
  documentCreate(input: $input) { document { title url } }
}`

/** Linear's priority numbers, as the issue tracker's priorities. */
const PRIORITIES: Record<number, string> = {
  0: "none",
  1: "urgent",
  2: "high",
  3: "medium",
  4: "low",
}

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

type AssignedNode = {
  identifier: string
  title: string
  url: string
  description?: string | null
  priority: number
  dueDate?: string | null
  state: { name: string; type: string }
  children?: { nodes: { state: { type: string } }[] }
  attachments?: { nodes: { url: string }[] }
  relations?: {
    nodes: { type: string; relatedIssue: { state: { type: string } } }[]
  }
}

/** Attachments that are pull or merge requests. */
function pullRequests(node: Pick<SearchNode, "attachments">): string[] {
  return (node.attachments?.nodes ?? [])
    .map((a) => a.url)
    .filter((url) => /\/(pull|merge_requests)\/\d+/.test(url))
}

/**
 * For a workspace other products share (`mention`): only issues whose title
 * or project names this one.
 */
export function mentionFilter(mention: unknown): Record<string, unknown> {
  if (typeof mention !== "string" || !mention.trim()) {
    return {}
  }
  return {
    and: [
      {
        or: [
          { title: { containsIgnoreCase: mention } },
          { project: { name: { containsIgnoreCase: mention } } },
        ],
      },
    ],
  }
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
          ...mentionFilter(input.values.mention),
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

export const assignedIssues: Adapter = {
  needs: "api",
  async run(input) {
    const nodes: AssignedNode[] = []
    let after: string | undefined
    do {
      const data = await graphql<{
        viewer: {
          assignedIssues: {
            nodes: AssignedNode[]
            pageInfo: { hasNextPage: boolean; endCursor: string | null }
          }
        }
      }>(input, ASSIGNED_ISSUES, { team: input.values.teamKey, after })
      const page = data.viewer.assignedIssues
      nodes.push(...page.nodes)
      after = page.pageInfo.hasNextPage
        ? (page.pageInfo.endCursor ?? undefined)
        : undefined
    } while (after)
    const open = (type: string) => OPEN_STATES.includes(type)
    return {
      issues: nodes.map((node) => ({
        id: node.identifier,
        title: node.title,
        url: node.url,
        state: node.state.name,
        stage: node.state.type === "started" ? "in progress" : "todo",
        priority: PRIORITIES[node.priority] ?? "none",
        dueDate: node.dueDate ?? null,
        openSubIssues: (node.children?.nodes ?? []).some((c) =>
          open(c.state.type),
        ),
        pullRequests: pullRequests(node),
        blocks: (node.relations?.nodes ?? []).some(
          (r) => r.type === "blocks" && open(r.relatedIssue.state.type),
        ),
        description: (node.description ?? "").slice(0, MAX_DESCRIPTION),
      })),
    }
  },
}

type Page<T> = {
  nodes: T[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

type ProjectNode = {
  identifier: string
  title: string
  url: string
  priority: number
  dueDate?: string | null
  state: { name: string }
  parent?: { identifier: string } | null
}

export const projectIssues: Adapter = {
  needs: "api",
  args: ["project"],
  async run(input) {
    const project = input.args.project?.trim()
    if (!project) {
      throw new Error("projectIssues needs --project <project>")
    }
    const nodes: ProjectNode[] = []
    let after: string | undefined
    do {
      const data = await graphql<{ issues: Page<ProjectNode> }>(
        input,
        PROJECT_ISSUES,
        { team: input.values.teamKey, project, after },
      )
      nodes.push(...data.issues.nodes)
      after = data.issues.pageInfo.hasNextPage
        ? (data.issues.pageInfo.endCursor ?? undefined)
        : undefined
    } while (after)
    return {
      issues: nodes.map((node) => ({
        id: node.identifier,
        title: node.title,
        url: node.url,
        state: node.state.name,
        priority: PRIORITIES[node.priority] ?? "none",
        dueDate: node.dueDate ?? null,
        parent: node.parent?.identifier ?? null,
      })),
    }
  },
}

type OptionsData = {
  teams: {
    nodes: {
      members: {
        nodes: {
          name: string
          displayName?: string
          email?: string
          active: boolean
        }[]
      }
      projects: { nodes: { name: string }[] }
      activeCycle?: { number: number } | null
      cycles: {
        nodes: {
          number: number
          name?: string | null
          startsAt: string
          endsAt: string
        }[]
      }
    }[]
  }
  issueLabels: { nodes: { name: string }[] }
}

export const fieldOptions: Adapter = {
  needs: "api",
  async run(input) {
    const data = await graphql<OptionsData>(input, FIELD_OPTIONS, {
      team: input.values.teamKey,
      now: new Date().toISOString(),
    })
    const team = data.teams.nodes[0]
    if (!team) {
      throw new Error(`Linear has no team with key ${input.values.teamKey}`)
    }
    const current = team.activeCycle?.number
    return {
      people: team.members.nodes
        .filter((m) => m.active)
        .map(({ name, displayName, email }) => ({ name, displayName, email })),
      projects: team.projects.nodes.map((p) => p.name),
      labels: [...new Set(data.issueLabels.nodes.map((l) => l.name))],
      cycles: [...team.cycles.nodes]
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
        .map((cycle) => ({
          id: String(cycle.number),
          ...(cycle.name ? { name: cycle.name } : {}),
          startsAt: cycle.startsAt.slice(0, 10),
          endsAt: cycle.endsAt.slice(0, 10),
          current: cycle.number === current,
        })),
    }
  },
}

type PlaceData = {
  teams: {
    nodes: {
      id: string
      activeCycle?: {
        id: string
        documents: { nodes: { id: string; title: string; url: string }[] }
      } | null
    }[]
  }
  documents: { nodes: { id: string; title: string; url: string }[] }
}

export const recordNotes: Adapter = {
  needs: "api",
  args: ["title", "section-file", "key"],
  async run(input) {
    const { title, key } = input.args
    const section = fs.readFileSync(
      input.args["section-file"] as string,
      "utf8",
    )
    const place = await graphql<PlaceData>(input, PLANNING_PLACE, {
      team: input.values.teamKey,
      title,
    })
    const team = place.teams.nodes[0]
    if (!team) {
      throw new Error(`Linear has no team with key ${input.values.teamKey}`)
    }
    const cycle = team.activeCycle
    const found =
      cycle?.documents.nodes.find((doc) => doc.title === title) ??
      place.documents.nodes[0]
    if (found) {
      const { document } = await graphql<{
        document: { content?: string | null }
      }>(input, DOCUMENT, { id: found.id })
      const updated = await graphql<{
        documentUpdate: { document: { title: string; url: string } }
      }>(input, DOCUMENT_UPDATE, {
        id: found.id,
        content: upsertSection(document.content ?? "", key as string, section),
      })
      return { ...updated.documentUpdate.document, created: false }
    }
    const created = await graphql<{
      documentCreate: { document: { title: string; url: string } }
    }>(input, DOCUMENT_CREATE, {
      input: {
        title,
        content: upsertSection("", key as string, section),
        ...(cycle ? { cycleId: cycle.id } : { teamId: team.id }),
      },
    })
    return { ...created.documentCreate.document, created: true }
  },
}

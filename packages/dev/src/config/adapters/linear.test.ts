import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { AdapterInput } from "../types.ts"
import {
  assignedIssues,
  branchAnchors,
  fieldOptions,
  findIssue,
  mentionFilter,
  projectIssues,
  recordNotes,
  searchIssues,
} from "./linear.ts"

const BRANCH = "ruven/eng-12-feature"
const LINE = `> Branch: \`${BRANCH}\``

function issue(identifier: string, description: string, updatedAt: string) {
  return {
    identifier,
    title: identifier,
    url: `https://l/${identifier}`,
    description,
    updatedAt,
  }
}

/** A fetch that serves `pages` in order and records each request's variables. */
function fakeLinear(pages: object[]) {
  const seen: Record<string, unknown>[] = []
  const fetch: typeof globalThis.fetch = (async (
    _url: string,
    init: RequestInit,
  ) => {
    const { variables } = JSON.parse(String(init.body))
    seen.push(variables)
    return new Response(JSON.stringify({ data: pages[seen.length - 1] }))
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

function issuePages(pages: object[][]): object[] {
  return pages.map((nodes, i) => ({
    issues: {
      nodes,
      pageInfo: { hasNextPage: i < pages.length - 1, endCursor: `c${i + 1}` },
    },
  }))
}

const input = (
  fetch: typeof globalThis.fetch,
  args: Record<string, string> = { branch: BRANCH },
): AdapterInput => ({ values: { teamKey: "ENG" }, args, token: "k", fetch })

describe("linear findIssue adapter", () => {
  it("reads every page and keeps only issues anchored to the branch, newest first", async () => {
    const { fetch, seen } = fakeLinear(
      issuePages([
        [
          issue("ENG-1", `${LINE}\n\n## Description`, "2026-10-01"),
          // Contains the text, but anchored to a longer branch.
          issue("ENG-2", `> Branch: \`${BRANCH}-two\``, "2026-10-05"),
        ],
        [issue("ENG-3", `Intro\n  ${LINE}  \nmore`, "2026-10-09")],
      ]),
    )
    expect(await findIssue.run(input(fetch))).toEqual({
      issues: [
        expect.objectContaining({ identifier: "ENG-3" }),
        expect.objectContaining({ identifier: "ENG-1" }),
      ],
    })
    expect(seen).toEqual([
      { team: "ENG", anchors: branchAnchors(BRANCH), after: undefined },
      { team: "ENG", anchors: branchAnchors(BRANCH), after: "c1" },
    ])
  })

  it("finds the bare and linked lines an earlier sync tool wrote", async () => {
    const { fetch } = fakeLinear(
      issuePages([
        [
          issue("ENG-4", `> Branch: ${BRANCH}\n\n## Description`, "2026-10-02"),
          issue(
            "ENG-5",
            "> Branch: ruven/[ENG-12](https://linear.app/a/issue/ENG-12)-feature",
            "2026-10-01",
          ),
        ],
      ]),
    )
    const result = (await findIssue.run(input(fetch))) as {
      issues: { identifier: string }[]
    }
    expect(result.issues.map((i) => i.identifier)).toEqual(["ENG-4", "ENG-5"])
  })

  it("asks the server for every way the line is stored", () => {
    expect(branchAnchors(BRANCH)).toEqual([
      { description: { contains: LINE } },
      { description: { contains: `> Branch: ${BRANCH}` } },
      { description: { containsIgnoreCase: "> Branch: ruven/[eng-12](" } },
    ])
    expect(branchAnchors("plain-branch")).toHaveLength(2)
  })

  it("fails loudly on an API error rather than reporting no issue", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({ errors: [{ message: "bad key" }] }),
      )) as typeof globalThis.fetch
    await expect(findIssue.run(input(fetch))).rejects.toThrow("bad key")
    const denied = (async () =>
      new Response("", { status: 401 })) as typeof globalThis.fetch
    await expect(findIssue.run(input(denied))).rejects.toThrow("HTTP 401")
  })
})

describe("linear searchIssues adapter", () => {
  it("searches open and recently closed issues and reports what's attached", async () => {
    const { fetch, seen } = fakeLinear([
      {
        searchIssues: {
          nodes: [
            {
              identifier: "ENG-7",
              title: "Same work",
              url: "https://l/ENG-7",
              description: "x".repeat(2000),
              state: { name: "In Progress", type: "started" },
              parent: { identifier: "ENG-1", title: "Epic" },
              attachments: {
                nodes: [
                  { url: "https://github.com/acme/web/pull/12" },
                  { url: "https://sentry.io/issues/1" },
                ],
              },
            },
            {
              identifier: "ENG-8",
              title: "Done before",
              url: "https://l/ENG-8",
              description: null,
              state: { name: "Done", type: "completed" },
              parent: null,
            },
          ],
        },
      },
    ])
    const result = (await searchIssues.run(
      input(fetch, { text: "Same work" }),
    )) as { issues: Record<string, unknown>[] }
    expect(result.issues).toEqual([
      expect.objectContaining({
        identifier: "ENG-7",
        open: true,
        parent: "ENG-1",
        pullRequests: ["https://github.com/acme/web/pull/12"],
      }),
      expect.objectContaining({
        identifier: "ENG-8",
        open: false,
        parent: null,
        pullRequests: [],
        description: "",
      }),
    ])
    expect(String(result.issues[0].description)).toHaveLength(1500)
    const filter = seen[0].filter as { team: unknown; or: unknown[] }
    expect(seen[0].term).toBe("Same work")
    expect(filter.team).toEqual({ key: { eq: "ENG" } })
    expect(filter.or).toHaveLength(3)
  })

  it("needs text to search for", async () => {
    const { fetch } = fakeLinear([])
    await expect(searchIssues.run(input(fetch, {}))).rejects.toThrow("--text")
  })
})

describe("linear assignedIssues adapter", () => {
  it("reads every page and reports what tickets-to-work sorts by", async () => {
    const node = (identifier: string, extra: object) => ({
      identifier,
      title: identifier,
      url: `https://l/${identifier}`,
      description: "Body",
      priority: 0,
      dueDate: null,
      state: { name: "Todo", type: "unstarted" },
      children: { nodes: [] },
      attachments: { nodes: [] },
      relations: { nodes: [] },
      ...extra,
    })
    const page = (nodes: object[], hasNextPage: boolean) => ({
      viewer: {
        assignedIssues: {
          nodes,
          pageInfo: { hasNextPage, endCursor: hasNextPage ? "c1" : null },
        },
      },
    })
    const { fetch, seen } = fakeLinear([
      page(
        [
          node("ENG-1", {
            priority: 2,
            dueDate: "2026-11-01",
            children: { nodes: [{ state: { type: "started" } }] },
          }),
        ],
        true,
      ),
      page(
        [
          node("ENG-2", {
            state: { name: "In Progress", type: "started" },
            attachments: { nodes: [{ url: "https://g/acme/web/pull/4" }] },
            relations: {
              nodes: [
                {
                  type: "blocks",
                  relatedIssue: { state: { type: "backlog" } },
                },
              ],
            },
          }),
        ],
        false,
      ),
    ])
    const result = (await assignedIssues.run(input(fetch, {}))) as {
      issues: Record<string, unknown>[]
    }
    expect(seen).toEqual([
      { team: "ENG", after: undefined },
      { team: "ENG", after: "c1" },
    ])
    expect(result.issues).toEqual([
      {
        id: "ENG-1",
        title: "ENG-1",
        url: "https://l/ENG-1",
        state: "Todo",
        stage: "todo",
        priority: "high",
        dueDate: "2026-11-01",
        openSubIssues: true,
        pullRequests: [],
        blocks: false,
        description: "Body",
      },
      expect.objectContaining({
        id: "ENG-2",
        stage: "in progress",
        priority: "none",
        openSubIssues: false,
        pullRequests: ["https://g/acme/web/pull/4"],
        blocks: true,
      }),
    ])
  })
})

describe("linear planning adapters", () => {
  it("reads every open issue in a project", async () => {
    const node = (id: string) => ({
      identifier: id,
      title: id,
      url: `https://l/${id}`,
      priority: 0,
      dueDate: null,
      state: { name: "Todo" },
      parent: { identifier: "ENG-1" },
    })
    const { fetch, seen } = fakeLinear(
      issuePages([[node("ENG-2")], [node("ENG-3")]]),
    )
    const result = (await projectIssues.run(
      input(fetch, { project: "Web" }),
    )) as {
      issues: { id: string; priority: string; parent: string }[]
    }
    expect(result.issues.map((i) => [i.id, i.priority, i.parent])).toEqual([
      ["ENG-2", "none", "ENG-1"],
      ["ENG-3", "none", "ENG-1"],
    ])
    expect(seen[1]).toMatchObject({ project: "Web", after: "c1" })
  })

  it("lists people, projects, labels, and cycles, marking the current one", async () => {
    const { fetch } = fakeLinear([
      {
        teams: {
          nodes: [
            {
              members: {
                nodes: [
                  {
                    name: "Sam Lee",
                    displayName: "sam",
                    email: "s@x",
                    active: true,
                  },
                  { name: "Gone", active: false },
                ],
              },
              projects: { nodes: [{ name: "Web" }] },
              activeCycle: { number: 40 },
              cycles: {
                nodes: [
                  {
                    number: 41,
                    startsAt: "2026-10-26T07:00:00Z",
                    endsAt: "2026-11-02T07:00:00Z",
                  },
                  {
                    number: 40,
                    startsAt: "2026-10-19T07:00:00Z",
                    endsAt: "2026-10-26T07:00:00Z",
                  },
                ],
              },
            },
          ],
        },
        issueLabels: {
          nodes: [{ name: "Bug" }, { name: "Bug" }, { name: "DX" }],
        },
      },
    ])
    expect(await fieldOptions.run(input(fetch, {}))).toEqual({
      people: [{ name: "Sam Lee", displayName: "sam", email: "s@x" }],
      projects: ["Web"],
      labels: ["Bug", "DX"],
      cycles: [
        {
          id: "40",
          startsAt: "2026-10-19",
          endsAt: "2026-10-26",
          current: true,
        },
        {
          id: "41",
          startsAt: "2026-10-26",
          endsAt: "2026-11-02",
          current: false,
        },
      ],
    })
  })

  it("replaces its section in the cycle's document, or creates the document in the cycle", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-"))
    const file = path.join(dir, "section.md")
    fs.writeFileSync(
      file,
      "## 2026-10-24: Sync\n\nSource: pasted notes (k1)\n\nNew",
    )
    const args = {
      title: "Planning, week of 2026-10-19",
      "section-file": file,
      key: "k1",
    }
    const cycle = (docs: object[]) => ({
      teams: {
        nodes: [
          {
            id: "team",
            activeCycle: { id: "cyc", documents: { nodes: docs } },
          },
        ],
      },
      documents: { nodes: [] },
    })

    const existing = fakeLinear([
      cycle([{ id: "doc", title: args.title, url: "https://l/doc" }]),
      {
        document: {
          content:
            "Intro\n\n## 2026-10-23: Sync\n\nSource: pasted notes (k1)\n\nOld",
        },
      },
      {
        documentUpdate: {
          document: { title: args.title, url: "https://l/doc" },
        },
      },
    ])
    expect(await recordNotes.run(input(existing.fetch, args))).toEqual({
      title: args.title,
      url: "https://l/doc",
      created: false,
    })
    expect(existing.seen[2]).toEqual({
      id: "doc",
      content:
        "Intro\n\n## 2026-10-24: Sync\n\nSource: pasted notes (k1)\n\nNew\n",
    })

    const fresh = fakeLinear([
      cycle([]),
      {
        documentCreate: {
          document: { title: args.title, url: "https://l/new" },
        },
      },
    ])
    expect(await recordNotes.run(input(fresh.fetch, args))).toMatchObject({
      created: true,
    })
    expect(fresh.seen[1]).toMatchObject({
      input: { title: args.title, cycleId: "cyc" },
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("narrows a shared workspace's search to issues that mention the product", () => {
    expect(mentionFilter(undefined)).toEqual({})
    expect(mentionFilter("Acme")).toEqual({
      and: [
        {
          or: [
            { title: { containsIgnoreCase: "Acme" } },
            { project: { name: { containsIgnoreCase: "Acme" } } },
          ],
        },
      ],
    })
  })
})

import { describe, expect, it } from "vitest"
import type { AdapterInput } from "../types.ts"
import { findIssue, hasLine } from "./linear.ts"

const LINE = "> Branch: `ruven/feature`"

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
function fakeLinear(pages: object[][]) {
  const seen: Record<string, unknown>[] = []
  const fetch: typeof globalThis.fetch = (async (
    _url: string,
    init: RequestInit,
  ) => {
    const { variables } = JSON.parse(String(init.body))
    seen.push(variables)
    const nodes = pages[seen.length - 1]
    return new Response(
      JSON.stringify({
        data: {
          issues: {
            nodes,
            pageInfo: {
              hasNextPage: seen.length < pages.length,
              endCursor: `c${seen.length}`,
            },
          },
        },
      }),
    )
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

const input = (fetch: typeof globalThis.fetch): AdapterInput => ({
  values: { teamKey: "ENG" },
  args: { line: LINE },
  token: "k",
  fetch,
})

describe("linear findIssue adapter", () => {
  it("reads every page and keeps only issues with the exact line, newest first", async () => {
    const { fetch, seen } = fakeLinear([
      [
        issue("ENG-1", `${LINE}\n\n## Description`, "2026-10-01"),
        // Contains the text, but anchored to a longer branch.
        issue("ENG-2", "> Branch: `ruven/feature-two`", "2026-10-05"),
      ],
      [issue("ENG-3", `Intro\n  ${LINE}  \nmore`, "2026-10-09")],
    ])
    expect(await findIssue.run(input(fetch))).toEqual({
      issues: [
        expect.objectContaining({ identifier: "ENG-3" }),
        expect.objectContaining({ identifier: "ENG-1" }),
      ],
    })
    expect(seen).toEqual([
      { team: "ENG", line: LINE, after: undefined },
      { team: "ENG", line: LINE, after: "c1" },
    ])
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

  it("matches whole lines only", () => {
    expect(hasLine("a\n> Branch: `x`\nb", "> Branch: `x`")).toBe(true)
    expect(hasLine("> Branch: `x-y`", "> Branch: `x`")).toBe(false)
  })
})

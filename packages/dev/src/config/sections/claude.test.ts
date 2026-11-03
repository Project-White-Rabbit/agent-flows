import { describe, expect, it } from "vitest"
import type { DetectContext } from "../types.ts"
import { claude, claudeWorkflow } from "./claude.ts"

const ON_MENTION = `name: Claude Code
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
jobs:
  claude:
    if: contains(github.event.comment.body, '@claude')
    steps:
      - uses: anthropics/claude-code-action@v1
`

const ON_PULL_REQUEST = `on:
  pull_request:
    types: [opened, synchronize]
jobs:
  review:
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          prompt: Review this pull request
`

function checkout(
  files: Record<string, string>,
  origin = "git@github.com:acme/web.git",
): DetectContext {
  return {
    tracked: Object.keys(files),
    read: (file: string) => files[file],
    git: (args: string[]) =>
      args.join(" ") === "remote get-url origin" ? origin : undefined,
  } as unknown as DetectContext
}

describe("claudeWorkflow", () => {
  it("finds a workflow that runs the action on a comment", () => {
    expect(claudeWorkflow(".github/workflows/claude.yml", ON_MENTION)).toEqual({
      workflow: "claude.yml",
      mention: "@claude",
    })
  })

  it("reads a custom trigger phrase", () => {
    const text = `${ON_MENTION}        with:\n          trigger_phrase: "@reviewbot"\n`
    expect(claudeWorkflow(".github/workflows/review.yaml", text)).toEqual({
      workflow: "review.yaml",
      mention: "@reviewbot",
    })
  })

  it("skips one that reviews by itself, with nothing to request", () => {
    expect(
      claudeWorkflow(".github/workflows/review.yml", ON_PULL_REQUEST),
    ).toBeUndefined()
  })
})

describe("claude detection", () => {
  it("proposes the workflow and the repository from the origin", () => {
    expect(
      claude.detect?.(
        checkout({
          ".github/workflows/review.yml": ON_PULL_REQUEST,
          ".github/workflows/claude.yml": ON_MENTION,
        }),
      ),
    ).toEqual({
      values: { owner: "acme", repo: "web", workflow: "claude.yml" },
      evidence: [
        ".github/workflows/claude.yml runs anthropics/claude-code-action when a comment mentions @claude",
      ],
    })
  })

  it("proposes nothing off GitHub, or without such a workflow", () => {
    const files = { ".github/workflows/claude.yml": ON_MENTION }
    expect(
      claude.detect?.(checkout(files, "git@gitlab.com:acme/web.git")),
    ).toBeUndefined()
    expect(
      claude.detect?.(
        checkout({ ".github/workflows/review.yml": ON_PULL_REQUEST }),
      ),
    ).toBeUndefined()
  })
})

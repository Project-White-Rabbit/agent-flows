import { describe, expect, it } from "vitest"
import { githubChecks } from "./github.ts"
import { gitlabChecks } from "./gitlab.ts"

describe("githubChecks", () => {
  it("reads check runs and commit statuses as one sorted list", () => {
    expect(
      githubChecks(
        [
          {
            id: 11,
            name: "validate",
            status: "completed",
            conclusion: "failure",
            details_url: "https://github.com/a/b/actions/runs/1/job/11",
            app: "github-actions",
          },
          {
            id: 12,
            name: "build",
            status: "in_progress",
            conclusion: null,
            app: "github-actions",
          },
          {
            id: 13,
            name: "docs",
            status: "completed",
            conclusion: "skipped",
            app: "github-actions",
          },
          {
            id: 14,
            name: "neutral",
            status: "completed",
            conclusion: "neutral",
            app: "some-app",
          },
          {
            id: 15,
            name: "e2e",
            status: "completed",
            conclusion: "cancelled",
            app: "github-actions",
          },
          {
            id: 16,
            name: "slow",
            status: "completed",
            conclusion: "timed_out",
            app: "github-actions",
          },
        ],
        [
          {
            context: "Vercel",
            state: "success",
            target_url: "https://vercel.com/x",
          },
          { context: "license", state: "pending" },
          { context: "cla", state: "error" },
        ],
      ),
    ).toEqual([
      { name: "build", state: "pending", log: "12" },
      { name: "cla", state: "fail" },
      { name: "docs", state: "skipping", log: "13" },
      { name: "e2e", state: "cancelled", log: "15" },
      { name: "license", state: "pending" },
      { name: "neutral", state: "pass" },
      { name: "slow", state: "fail", log: "16" },
      {
        name: "validate",
        state: "fail",
        link: "https://github.com/a/b/actions/runs/1/job/11",
        log: "11",
      },
      { name: "Vercel", state: "pass", link: "https://vercel.com/x" },
    ])
  })
})

describe("gitlabChecks", () => {
  it("maps statuses, lets allowed failures through, and logs only jobs", () => {
    expect(
      gitlabChecks([
        {
          id: 1,
          name: "test",
          status: "failed",
          target_url: "https://gitlab.com/a/b/-/jobs/101",
        },
        {
          id: 2,
          name: "lint",
          status: "failed",
          allow_failure: true,
          target_url: "https://gitlab.com/a/b/-/jobs/102",
        },
        { id: 3, name: "build", status: "running" },
        { id: 4, name: "deploy", status: "manual" },
        { id: 5, name: "e2e", status: "canceled" },
        {
          id: 6,
          name: "external",
          status: "success",
          target_url: "https://ci.example.com/run/9",
        },
      ]),
    ).toEqual([
      { name: "build", state: "pending" },
      { name: "deploy", state: "skipping" },
      { name: "e2e", state: "cancelled" },
      { name: "external", state: "pass", link: "https://ci.example.com/run/9" },
      {
        name: "lint",
        state: "skipping",
        link: "https://gitlab.com/a/b/-/jobs/102",
        log: "102",
      },
      {
        name: "test",
        state: "fail",
        link: "https://gitlab.com/a/b/-/jobs/101",
        log: "101",
      },
    ])
  })
})

describe("required checks", () => {
  it("marks GitHub's required checks, and waits on one that hasn't started", () => {
    const checks = githubChecks(
      [
        {
          id: 1,
          name: "ci-required",
          status: "completed",
          conclusion: "success",
        },
        { id: 2, name: "preview", status: "in_progress", conclusion: null },
      ],
      [{ context: "license", state: "success" }],
      new Set(["ci-required", "license", "e2e"]),
    )
    expect(checks.map((c) => [c.name, c.state, c.required])).toEqual([
      ["ci-required", "pass", true],
      ["e2e", "pending", true],
      ["license", "pass", true],
      ["preview", "pending", false],
    ])
  })

  it("requires every GitLab job but one allowed to fail, only with a base", () => {
    const statuses = [
      { id: 1, name: "test", status: "success" },
      { id: 2, name: "flaky", status: "failed", allow_failure: true },
    ]
    expect(gitlabChecks(statuses, "main").map((c) => c.required)).toEqual([
      false,
      true,
    ])
    expect(gitlabChecks(statuses).every((c) => c.required === undefined)).toBe(
      true,
    )
  })
})

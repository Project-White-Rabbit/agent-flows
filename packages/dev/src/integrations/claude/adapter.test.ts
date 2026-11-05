import { describe, expect, it } from "vitest"
import {
  type Comment,
  MISSING_AFTER_MS,
  pickRun,
  postedSince,
  requestBody,
  reviewState,
  skippedRun,
  type WorkflowRun,
} from "./adapter.ts"

const SINCE = "2026-11-02T10:00:00Z"

function run(
  id: number,
  created: string,
  extra: Partial<WorkflowRun> = {},
): WorkflowRun {
  return {
    id,
    html_url: `https://github.com/acme/web/actions/runs/${id}`,
    status: "completed",
    conclusion: "success",
    created_at: created,
    event: "issue_comment",
    display_title: "Fix the login redirect",
    ...extra,
  }
}

describe("requestBody", () => {
  it("carries the mention and the commit, or the workflow skips it", () => {
    const body = requestBody("@claude", "abc1234")
    expect(body.startsWith("@claude ")).toBe(true)
    expect(body).toContain("abc1234")
  })
})

describe("pickRun", () => {
  it("takes the earliest run since the request on this pull request, past the skipped ones", () => {
    const runs = [
      run(4, "2026-11-02T10:00:40Z"),
      run(3, "2026-11-02T10:00:20Z", { conclusion: "skipped" }),
      run(2, "2026-11-02T10:00:30Z", { display_title: "Another PR" }),
      run(1, "2026-11-02T09:59:00Z"),
    ]
    expect(pickRun(runs, SINCE, "Fix the login redirect")).toEqual({
      run: runs[0],
      loose: false,
    })
  })

  it("still takes a run that hasn't finished", () => {
    const pending = run(5, "2026-11-02T10:00:05Z", {
      status: "in_progress",
      conclusion: null,
    })
    expect(pickRun([pending], SINCE, "Fix the login redirect")?.run).toBe(
      pending,
    )
  })

  it("falls back to any run since the request, flagged as loose", () => {
    const other = run(2, "2026-11-02T10:00:30Z", { display_title: "Other" })
    expect(pickRun([other], SINCE, "Fix the login redirect")).toEqual({
      run: other,
      loose: true,
    })
  })

  it("ignores runs from other events and from before the request", () => {
    const runs = [
      run(1, "2026-11-02T09:59:59Z"),
      run(2, "2026-11-02T10:01:00Z", { event: "pull_request" }),
    ]
    expect(pickRun(runs, SINCE, "Fix the login redirect")).toBeUndefined()
  })
})

describe("skippedRun", () => {
  it("finds a skipped run on this pull request since the request", () => {
    const mine = run(3, "2026-11-02T10:00:20Z", { conclusion: "skipped" })
    const runs = [
      run(4, "2026-11-02T10:00:10Z", {
        conclusion: "skipped",
        display_title: "Another PR",
      }),
      run(1, "2026-11-02T09:59:00Z", { conclusion: "skipped" }),
      mine,
      run(5, "2026-11-02T10:00:30Z", { conclusion: "success" }),
    ]
    expect(skippedRun(runs, SINCE, "Fix the login redirect")).toBe(mine)
    expect(skippedRun(runs.slice(0, 2), SINCE, "Fix the login redirect")).toBe(
      undefined,
    )
  })
})

describe("reviewState", () => {
  const since = Date.parse(SINCE)

  it("waits for a run, then calls it missing after 3 minutes", () => {
    expect(reviewState(undefined, SINCE, since + 60_000)).toBe("pending")
    expect(reviewState(undefined, SINCE, since + MISSING_AFTER_MS + 1)).toBe(
      "missing",
    )
  })

  it("calls it skipped past the wait when the pull request's only run since skipped", () => {
    const skipped = run(3, "2026-11-02T10:00:20Z", { conclusion: "skipped" })
    expect(reviewState(undefined, SINCE, since + 60_000, skipped)).toBe(
      "pending",
    )
    expect(
      reviewState(undefined, SINCE, since + MISSING_AFTER_MS + 1, skipped),
    ).toBe("skipped")
  })

  it("reads a run's status and conclusion", () => {
    const now = since + 60_000
    expect(
      reviewState(
        run(1, SINCE, { status: "queued", conclusion: null }),
        SINCE,
        now,
      ),
    ).toBe("pending")
    expect(reviewState(run(1, SINCE), SINCE, now)).toBe("done")
    expect(
      reviewState(run(1, SINCE, { conclusion: "failure" }), SINCE, now),
    ).toBe("failed")
    expect(
      reviewState(run(1, SINCE, { conclusion: "cancelled" }), SINCE, now),
    ).toBe("failed")
  })
})

describe("postedSince", () => {
  const comment = (login: string, at: string | null, body = "Looks off") =>
    ({
      login,
      at,
      body,
      html_url: `https://github.com/acme/web/pull/1#${login}-${at}`,
    }) satisfies Comment

  it("keeps the bot's non-empty posts since the request", () => {
    const mine = comment("claude[bot]", "2026-11-02T10:02:00Z")
    expect(
      postedSince(
        [
          mine,
          comment("claude[bot]", "2026-11-02T09:00:00Z"),
          comment("vercel[bot]", "2026-11-02T10:02:00Z"),
          comment("someone", "2026-11-02T10:03:00Z"),
          comment("claude[bot]", "2026-11-02T10:04:00Z", "  "),
          comment("claude[bot]", null),
        ],
        SINCE,
        "claude[bot]",
      ),
    ).toEqual([mine])
  })
})

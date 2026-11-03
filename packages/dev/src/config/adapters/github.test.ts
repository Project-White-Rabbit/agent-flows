import { describe, expect, it } from "vitest"
import { deployState, type GithubRun, latestRun, stepState } from "./github.ts"

const run = (
  id: number,
  created: string,
  extra: Partial<GithubRun> = {},
): GithubRun => ({
  id,
  html_url: `https://github.com/acme/web/actions/runs/${id}`,
  status: "completed",
  conclusion: "success",
  created_at: created,
  ...extra,
})

describe("deployment", () => {
  it("watches the latest run on the commit, so a re-run counts", () => {
    const first = run(1, "2026-11-02T10:00:00Z", { conclusion: "failure" })
    const rerun = run(2, "2026-11-02T10:20:00Z")
    expect(latestRun([first, rerun])).toBe(rerun)
    expect(latestRun([])).toBeUndefined()
  })

  it("reads a run as a deployment", () => {
    expect(deployState(undefined)).toBe("none")
    expect(
      deployState(run(1, "", { status: "in_progress", conclusion: null })),
    ).toBe("pending")
    expect(deployState(run(1, ""))).toBe("success")
    expect(deployState(run(1, "", { conclusion: "cancelled" }))).toBe("failed")
    expect(deployState(run(1, "", { conclusion: "failure" }))).toBe("failed")
  })

  it("reads each job as a step", () => {
    const job = (status: string, conclusion: string | null) =>
      stepState({ name: "migrate", status, conclusion })
    expect(job("queued", null)).toBe("pending")
    expect(job("completed", "success")).toBe("success")
    expect(job("completed", "skipped")).toBe("skipped")
    expect(job("completed", "timed_out")).toBe("failed")
  })
})

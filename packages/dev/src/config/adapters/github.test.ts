import { describe, expect, it } from "vitest"
import {
  CODE_SCANNING_APP,
  codeScanningAlert,
  deployState,
  deployStep,
  type GithubRun,
  githubChecks,
  latestRun,
  stepState,
} from "./github.ts"

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
      stepState({ id: 7, name: "migrate", status, conclusion })
    expect(job("queued", null)).toBe("pending")
    expect(job("completed", "success")).toBe("success")
    expect(job("completed", "skipped")).toBe("skipped")
    expect(job("completed", "timed_out")).toBe("failed")
  })

  it("gives each step its job id, so checkLog can read a failed one", () => {
    expect(
      deployStep({
        id: 4242,
        name: "Run migrations",
        status: "completed",
        conclusion: "failure",
      }),
    ).toEqual({ name: "Run migrations", state: "failed", log: "4242" })
  })
})

describe("code scanning", () => {
  it("marks a code-scanning check run, which has no Actions log", () => {
    expect(
      githubChecks(
        [
          {
            id: 21,
            name: "CodeQL",
            status: "completed",
            conclusion: "failure",
            details_url: "https://github.com/acme/web/runs/21",
            app: CODE_SCANNING_APP,
          },
        ],
        [],
      ),
    ).toEqual([
      {
        name: "CodeQL",
        state: "fail",
        link: "https://github.com/acme/web/runs/21",
        codeScanning: true,
      },
    ])
  })

  it("reads an alert as where it is, its rule, and what it says", () => {
    expect(
      codeScanningAlert({
        number: 7,
        html_url: "https://github.com/acme/web/security/code-scanning/7",
        rule: {
          id: "py/sql-injection",
          name: "SQL injection",
          severity: "error",
          security_severity_level: "high",
          description: "Building a query from user input",
        },
        tool: { name: "CodeQL" },
        most_recent_instance: {
          message: { text: "This query depends on a user-provided value." },
          location: { path: "api/db.py", start_line: 42 },
        },
      }),
    ).toEqual({
      rule: "py/sql-injection",
      severity: "high",
      tool: "CodeQL",
      path: "api/db.py",
      line: 42,
      message: "This query depends on a user-provided value.",
      url: "https://github.com/acme/web/security/code-scanning/7",
    })
  })

  it("falls back to the rule's own severity and description", () => {
    expect(
      codeScanningAlert({
        number: 8,
        html_url: "https://github.com/acme/web/security/code-scanning/8",
        rule: {
          id: "js/unused-local-variable",
          severity: "note",
          security_severity_level: null,
          description: "Unused variable",
        },
        tool: null,
        most_recent_instance: null,
      }),
    ).toEqual({
      rule: "js/unused-local-variable",
      severity: "note",
      tool: null,
      path: null,
      line: null,
      message: "Unused variable",
      url: "https://github.com/acme/web/security/code-scanning/8",
    })
  })
})

// GitHub ops as code. `checks` needs it: a commit's checks are two lists
// (Actions and apps' check runs, and the older commit statuses), each paged,
// with states the flow reads as one set.
//
// Runtime code: Node built-ins only.

import type { Adapter } from "../types.ts"
import {
  type Check,
  type CheckState,
  cli,
  jsonLines,
  sortChecks,
} from "./checks.ts"

export type GithubCheckRun = {
  id: number
  name: string
  status: string
  conclusion: string | null
  details_url?: string | null
  html_url?: string | null
  app?: string | null
}

export type GithubStatus = {
  context: string
  state: string
  target_url?: string | null
}

export function checkRunState(run: GithubCheckRun): CheckState {
  if (run.status !== "completed") {
    return "pending"
  }
  switch (run.conclusion) {
    case "success":
    case "neutral":
      return "pass"
    case "skipped":
      return "skipping"
    case "cancelled":
      return "cancelled"
    default:
      // failure, timed_out, action_required, stale, startup_failure
      return "fail"
  }
}

export function statusState(status: GithubStatus): CheckState {
  switch (status.state) {
    case "success":
      return "pass"
    case "pending":
      return "pending"
    default:
      return "fail"
  }
}

/** Both lists as one. An Actions job's check run id is its job id, which its log is read by. */
export function githubChecks(
  runs: GithubCheckRun[],
  statuses: GithubStatus[],
): Check[] {
  const all: Check[] = [
    ...runs.map((run) => {
      const link = run.details_url || run.html_url || undefined
      return {
        name: run.name,
        state: checkRunState(run),
        ...(link ? { link } : {}),
        ...(run.app === "github-actions" ? { log: String(run.id) } : {}),
      }
    }),
    ...statuses.map((status) => ({
      name: status.context,
      state: statusState(status),
      ...(status.target_url ? { link: status.target_url } : {}),
    })),
  ]
  return sortChecks(all)
}

export const checks: Adapter = {
  needs: "cli",
  args: ["sha"],
  async run({ values, args }) {
    const repo = `repos/${values.owner}/${values.repo}/commits/${args.sha}`
    const runs = jsonLines<GithubCheckRun>(
      cli("gh", [
        "api",
        "--paginate",
        `${repo}/check-runs?per_page=100`,
        "--jq",
        ".check_runs[] | {id, name, status, conclusion, details_url, html_url, app: .app.slug}",
      ]),
    )
    const statuses = jsonLines<GithubStatus>(
      cli("gh", [
        "api",
        "--paginate",
        `${repo}/status?per_page=100`,
        "--jq",
        ".statuses[] | {context, state, target_url}",
      ]),
    )
    return { checks: githubChecks(runs, statuses) }
  },
}

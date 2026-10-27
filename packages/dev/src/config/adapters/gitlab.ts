// GitLab ops as code. `checks` needs it: a commit's statuses come a page at a
// time, and only a pipeline job's status has a log, told apart by its URL.
//
// Runtime code: Node built-ins only.

import type { Adapter } from "../types.ts"
import { type Check, type CheckState, cli, sortChecks } from "./checks.ts"

export type GitlabStatus = {
  id: number
  name: string
  status: string
  allow_failure?: boolean
  target_url?: string | null
}

const PAGE = 100

export function gitlabState(status: GitlabStatus): CheckState {
  switch (status.status) {
    case "success":
      return "pass"
    case "failed":
      // A job allowed to fail doesn't block the merge request.
      return status.allow_failure ? "skipping" : "fail"
    case "canceled":
    case "canceling":
      return "cancelled"
    case "skipped":
    case "manual":
      return "skipping"
    default:
      // created, waiting_for_resource, preparing, pending, running, scheduled
      return "pending"
  }
}

export function gitlabChecks(statuses: GitlabStatus[]): Check[] {
  return sortChecks(
    statuses.map((status) => {
      const job = status.target_url?.match(/\/-\/jobs\/(\d+)/)?.[1]
      return {
        name: status.name,
        state: gitlabState(status),
        ...(status.target_url ? { link: status.target_url } : {}),
        ...(job ? { log: job } : {}),
      }
    }),
  )
}

export const checks: Adapter = {
  needs: "cli",
  args: ["sha"],
  async run({ values, args }) {
    const project = encodeURIComponent(String(values.project))
    const host = typeof values.host === "string" ? values.host : "gitlab.com"
    const statuses: GitlabStatus[] = []
    for (let page = 1; ; page++) {
      const batch = JSON.parse(
        cli("glab", [
          "api",
          "--hostname",
          host,
          `projects/${project}/repository/commits/${args.sha}/statuses?per_page=${PAGE}&page=${page}`,
        ]),
      ) as GitlabStatus[]
      statuses.push(...batch)
      if (batch.length < PAGE) {
        break
      }
    }
    return { checks: gitlabChecks(statuses) }
  },
}

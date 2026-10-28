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

/**
 * Both lists as one. An Actions job's check run id is its job id, which its
 * log is read by. With `required` (the base's required check names), each
 * check says whether it's one.
 */
export function githubChecks(
  runs: GithubCheckRun[],
  statuses: GithubStatus[],
  required?: Set<string>,
): Check[] {
  const need = (name: string) =>
    required ? { required: required.has(name) } : {}
  const all: Check[] = [
    ...runs.map((run) => {
      const link = run.details_url || run.html_url || undefined
      return {
        name: run.name,
        state: checkRunState(run),
        ...(link ? { link } : {}),
        ...(run.app === "github-actions" ? { log: String(run.id) } : {}),
        ...need(run.name),
      }
    }),
    ...statuses.map((status) => ({
      name: status.context,
      state: statusState(status),
      ...(status.target_url ? { link: status.target_url } : {}),
      ...need(status.context),
    })),
  ]
  // A required check that hasn't started yet still has to pass.
  for (const name of required ?? []) {
    if (!all.some((check) => check.name === name)) {
      all.push({ name, state: "pending", required: true })
    }
  }
  return sortChecks(all)
}

/**
 * The check names merging into `base` requires: its branch protection's and
 * its rulesets'. Each is readable with read access; one that fails (no
 * protection, an old GitHub) adds none.
 */
export function requiredChecks(repo: string, base: string): Set<string> {
  const names = new Set<string>()
  const branch = encodeURIComponent(base)
  const read = (args: string[]) => {
    try {
      for (const line of cli("gh", args).split("\n")) {
        if (line.trim()) {
          names.add(line.trim())
        }
      }
    } catch {
      // Unprotected, or not readable here: nothing required from this source.
    }
  }
  read([
    "api",
    `repos/${repo}/branches/${branch}`,
    "--jq",
    ".protection.required_status_checks.contexts[]?",
  ])
  read([
    "api",
    "--paginate",
    `repos/${repo}/rules/branches/${branch}`,
    "--jq",
    '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context',
  ])
  return names
}

export const checks: Adapter = {
  needs: "cli",
  args: ["sha"],
  optional: ["base"],
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
    const required = args.base
      ? requiredChecks(`${values.owner}/${values.repo}`, args.base)
      : undefined
    return { checks: githubChecks(runs, statuses, required) }
  },
}

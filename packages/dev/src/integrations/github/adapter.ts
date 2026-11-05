// GitHub ops as code. `checks` needs it: a commit's checks are two lists
// (Actions and apps' check runs, and the older commit statuses), each paged,
// with states the flow reads as one set.
//
// Runtime code: Node built-ins only.

import type { Adapter } from "../../config/types.ts"
import {
  type Check,
  type CheckState,
  cli,
  jsonLines,
  sortChecks,
} from "../checks.ts"

export type GithubCheckRun = {
  id: number
  name: string
  status: string
  conclusion: string | null
  details_url?: string | null
  html_url?: string | null
  app?: string | null
}

/** The app code scanning (CodeQL) reports its check runs as. They have no Actions log. */
export const CODE_SCANNING_APP = "github-advanced-security"

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
        ...(run.app === CODE_SCANNING_APP ? { codeScanning: true } : {}),
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

/** One code-scanning alert, as the REST API's list gives it (the fields read). */
export type GithubAlert = {
  number: number
  html_url: string
  rule?: {
    id?: string | null
    name?: string | null
    severity?: string | null
    security_severity_level?: string | null
    description?: string | null
  } | null
  tool?: { name?: string | null } | null
  most_recent_instance?: {
    message?: { text?: string | null } | null
    location?: { path?: string | null; start_line?: number | null } | null
  } | null
}

export type CodeScanningAlert = {
  rule: string
  /** The security severity when the rule has one (`high`), else the rule's own (`warning`). */
  severity: string | null
  tool: string | null
  path: string | null
  line: number | null
  message: string
  url: string
}

/** An alert as the op prints it: where it is, what rule, and what it says. */
export function codeScanningAlert(alert: GithubAlert): CodeScanningAlert {
  const instance = alert.most_recent_instance
  return {
    rule: alert.rule?.id ?? alert.rule?.name ?? "",
    severity:
      alert.rule?.security_severity_level ?? alert.rule?.severity ?? null,
    tool: alert.tool?.name ?? null,
    path: instance?.location?.path ?? null,
    line: instance?.location?.start_line ?? null,
    message: instance?.message?.text ?? alert.rule?.description ?? "",
    url: alert.html_url,
  }
}

export const codeScanningAlerts: Adapter = {
  needs: "cli",
  args: ["pr"],
  async run({ values, args }) {
    if (!/^\d+$/.test(args.pr ?? "")) {
      throw new Error(`--pr must be a pull request number, got \`${args.pr}\``)
    }
    // A pull request's analysis is of its merge ref, so its alerts are too.
    const ref = encodeURIComponent(`refs/pull/${args.pr}/merge`)
    const alerts = jsonLines<GithubAlert>(
      cli("gh", [
        "api",
        "--paginate",
        `repos/${values.owner}/${values.repo}/code-scanning/alerts?ref=${ref}&state=open&per_page=100`,
        "--jq",
        ".[] | {number, html_url, rule, tool, most_recent_instance}",
      ]),
    )
    return { alerts: alerts.map(codeScanningAlert) }
  },
}

export type GithubRun = {
  id: number
  html_url: string
  status: string
  conclusion: string | null
  created_at: string
}

export type GithubJob = {
  id: number
  name: string
  status: string
  conclusion: string | null
}

export type DeployState = "none" | "pending" | "success" | "failed"
export type StepState = "pending" | "success" | "failed" | "skipped"

/** A workflow run's state, read as a deployment's. */
export function deployState(run: GithubRun | undefined): DeployState {
  if (!run) {
    return "none"
  }
  if (run.status !== "completed") {
    return "pending"
  }
  return run.conclusion === "success" ? "success" : "failed"
}

export function stepState(job: GithubJob): StepState {
  if (job.status !== "completed") {
    return "pending"
  }
  switch (job.conclusion) {
    case "success":
    case "neutral":
      return "success"
    case "skipped":
      return "skipped"
    default:
      return "failed"
  }
}

/** A job as a deployment step, with the id `checkLog` reads its log by. */
export function deployStep(job: GithubJob): {
  name: string
  state: StepState
  log: string
} {
  return { name: job.name, state: stepState(job), log: String(job.id) }
}

/** The latest run on the commit: a re-run of the deploy is the one that counts. */
export function latestRun(runs: GithubRun[]): GithubRun | undefined {
  return [...runs].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )[0]
}

export const deployment: Adapter = {
  needs: "cli",
  args: ["sha"],
  async run({ values, args }) {
    const workflow = values.deployWorkflow
    if (typeof workflow !== "string") {
      throw new Error(
        "set the entry's `deployWorkflow` (the workflow file that deploys a push to the base branch) to watch its deployments",
      )
    }
    if (!/^[0-9a-f]{7,40}$/i.test(args.sha ?? "")) {
      throw new Error(`--sha must be a commit sha, got \`${args.sha}\``)
    }
    const repo = `repos/${values.owner}/${values.repo}`
    const { workflow_runs: runs } = JSON.parse(
      cli("gh", [
        "api",
        `${repo}/actions/workflows/${workflow}/runs?head_sha=${args.sha}&per_page=100`,
      ]),
    ) as { workflow_runs: GithubRun[] }
    const run = latestRun(runs)
    if (!run) {
      return { state: "none", url: null, steps: [] }
    }
    const jobs = jsonLines<GithubJob>(
      cli("gh", [
        "api",
        "--paginate",
        `${repo}/actions/runs/${run.id}/jobs?per_page=100`,
        "--jq",
        ".jobs[] | {id, name, status, conclusion}",
      ]),
    )
    return {
      state: deployState(run),
      url: run.html_url,
      steps: jobs.map(deployStep),
    }
  },
}

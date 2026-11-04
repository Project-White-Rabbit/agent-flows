// Claude Code's GitHub Action as code. Its workflow wakes on a comment that
// mentions it, so a review is a comment, then a run to find, then whatever it
// posted after the comment. Finding the run is the part prose gets wrong: the
// workflow fires on every comment and skips the ones without the mention, so
// the newest run is usually a skipped one, or another pull request's.
//
// Runtime code: Node built-ins only.

import type { Adapter, SectionValues } from "../types.ts"
import { cli, jsonLines } from "./checks.ts"

export const DEFAULT_MENTION = "@claude"
export const DEFAULT_BOT = "claude[bot]"

/** How long a request may go without a run before it counts as missed. */
export const MISSING_AFTER_MS = 3 * 60 * 1000

export type ReviewState = "pending" | "done" | "failed" | "missing" | "skipped"

export type WorkflowRun = {
  id: number
  html_url: string
  status: string
  conclusion: string | null
  created_at: string
  event: string
  /** For a comment's run, the title of the issue or pull request it's on. */
  display_title?: string
}

export type Comment = {
  login: string
  body: string | null
  html_url: string
  /** A comment's `created_at`, a review's `submitted_at`. */
  at: string | null
}

export type Finding = {
  author: string
  kind: "comment" | "review"
  body: string
  url: string
}

/** The comment that asks for the review. It has to carry the mention, or the workflow skips it. */
export function requestBody(mention: string, sha: string): string {
  return `${mention} review this pull request at ${sha}. Focus on correctness bugs, unhandled edge cases, and anything that would break in production, and point at file:line for each finding.`
}

/**
 * The run a request started: the earliest comment run created since the
 * request on the pull request (by its title), that didn't skip. Without one on
 * the pull request, the earliest such run anywhere, flagged as a loose match.
 */
export function pickRun(
  runs: WorkflowRun[],
  since: string,
  title?: string,
): { run: WorkflowRun; loose: boolean } | undefined {
  const from = Date.parse(since)
  const live = runs
    .filter(
      (run) =>
        run.event === "issue_comment" &&
        run.conclusion !== "skipped" &&
        Date.parse(run.created_at) >= from,
    )
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  const own = title ? live.find((run) => run.display_title === title) : live[0]
  if (own) {
    return { run: own, loose: false }
  }
  return live[0] ? { run: live[0], loose: true } : undefined
}

/**
 * A run on this pull request since the request that skipped: with no other
 * run, the workflow woke for the request but its condition turned it away
 * (a mention it didn't match).
 */
export function skippedRun(
  runs: WorkflowRun[],
  since: string,
  title: string,
): WorkflowRun | undefined {
  const from = Date.parse(since)
  return runs
    .filter(
      (run) =>
        run.event === "issue_comment" &&
        run.conclusion === "skipped" &&
        run.display_title === title &&
        Date.parse(run.created_at) >= from,
    )
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0]
}

/**
 * Where a request stands, from its run (or the lack of one) at `now`. With no
 * run past the wait, a skipped run on the pull request makes it `skipped`.
 */
export function reviewState(
  run: WorkflowRun | undefined,
  since: string,
  now: number,
  skipped?: WorkflowRun,
): ReviewState {
  if (!run) {
    if (now - Date.parse(since) <= MISSING_AFTER_MS) {
      return "pending"
    }
    return skipped ? "skipped" : "missing"
  }
  if (run.status !== "completed") {
    return "pending"
  }
  return run.conclusion === "success" ? "done" : "failed"
}

/** What `bot` posted since the request, with something in it. */
export function postedSince(
  items: Comment[],
  since: string,
  bot: string,
): Comment[] {
  const from = Date.parse(since)
  return items.filter(
    (item) =>
      item.login === bot &&
      item.at !== null &&
      Date.parse(item.at) >= from &&
      (item.body ?? "").trim() !== "",
  )
}

function repoOf(values: SectionValues): string {
  return `repos/${values.owner}/${values.repo}`
}

function prNumber(value: string | undefined): string {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`--pr must be a pull request number, got \`${value}\``)
  }
  return value
}

const COMMENT_JQ = ".[] | {login: .user.login, body, html_url, at: .created_at}"

function comments(path: string, jq = COMMENT_JQ): Comment[] {
  return jsonLines<Comment>(cli("gh", ["api", "--paginate", path, "--jq", jq]))
}

export const requestReview: Adapter = {
  needs: "cli",
  args: ["pr", "sha"],
  async run({ values, args }) {
    const pr = prNumber(args.pr)
    if (!/^[0-9a-f]{7,40}$/i.test(args.sha ?? "")) {
      throw new Error(`--sha must be a commit sha, got \`${args.sha}\``)
    }
    const mention =
      typeof values.mention === "string" ? values.mention : DEFAULT_MENTION
    const created = JSON.parse(
      cli("gh", [
        "api",
        "--method",
        "POST",
        `${repoOf(values)}/issues/${pr}/comments`,
        "-f",
        `body=${requestBody(mention, args.sha)}`,
      ]),
    ) as { created_at: string; html_url: string }
    // The host's clock, not this machine's: the runs and replies it's
    // compared with carry the host's.
    return { requested: created.created_at, url: created.html_url }
  },
}

export const reviewResult: Adapter = {
  needs: "cli",
  args: ["pr", "requested"],
  async run({ values, args }) {
    const pr = prNumber(args.pr)
    const since = args.requested ?? ""
    if (Number.isNaN(Date.parse(since))) {
      throw new Error(`--requested must be an ISO 8601 time, got \`${since}\``)
    }
    const repo = repoOf(values)
    const bot = typeof values.bot === "string" ? values.bot : DEFAULT_BOT
    const title = JSON.parse(
      cli("gh", ["api", `${repo}/pulls/${pr}`, "--jq", "{title}"]),
    ).title as string
    const { workflow_runs: runs } = JSON.parse(
      cli("gh", [
        "api",
        `${repo}/actions/workflows/${values.workflow}/runs?event=issue_comment&per_page=100`,
      ]),
    ) as { workflow_runs: WorkflowRun[] }
    const picked = pickRun(runs, since, title)
    const skipped = picked ? undefined : skippedRun(runs, since, title)
    const state = reviewState(picked?.run, since, Date.now(), skipped)
    const encoded = encodeURIComponent(since)
    const posted = postedSince(
      comments(`${repo}/issues/${pr}/comments?per_page=100&since=${encoded}`),
      since,
      bot,
    )
    const reviews = postedSince(
      comments(
        `${repo}/pulls/${pr}/reviews?per_page=100`,
        ".[] | {login: .user.login, body, html_url, at: .submitted_at}",
      ),
      since,
      bot,
    )
    const inline = postedSince(
      comments(`${repo}/pulls/${pr}/comments?per_page=100&since=${encoded}`),
      since,
      bot,
    ).length
    const findings: Finding[] = [
      ...posted.map((c) => ({ kind: "comment" as const, ...finding(c) })),
      ...reviews.map((c) => ({ kind: "review" as const, ...finding(c) })),
    ]
    return {
      state,
      run:
        picked?.run.html_url ??
        (state === "skipped" ? skipped?.html_url : undefined) ??
        null,
      ...(picked?.loose
        ? {
            note: `No ${values.workflow} run since the request names this pull request; this is the first one on any, which may be someone else's`,
          }
        : {}),
      findings,
      inline,
    }
  },
}

function finding(comment: Comment): Omit<Finding, "kind"> {
  return {
    author: comment.login,
    body: comment.body ?? "",
    url: comment.html_url,
  }
}

import { hookField } from "../hooks.ts"
import type { FieldPattern, SectionSpec } from "../types.ts"

const THREADS: FieldPattern = {
  regex: /^(allow|bots|all)$/,
  hint: "`allow`, `bots`, or `all`",
}

/** A source-control login, a bot's with its `[bot]` suffix or without. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[bot\])?$/

const SYNC: FieldPattern = {
  regex: /^(full|remote)$/,
  hint: "`full` or `remote`",
}

const EVALUATION: FieldPattern = {
  regex: /^(pass|flag)$/,
  hint: "`pass` or `flag`",
}

const ISSUE_ON_MERGE: FieldPattern = {
  regex: /^(close|tracker|leave)$/,
  hint: "`close`, `tracker`, or `leave`",
}

export const merge: SectionSpec = {
  path: "merge",
  name: "Merge",
  purpose:
    "Whether merge closes the issue itself, and the repo's own steps before merge lands a branch, before its CI wait, and after, for checks and cleanup no integration covers",
  fields: [
    {
      key: "issueOnMerge",
      description:
        "What happens to the pull request's issue when it merges. `close` (the default): sync links it with the issue tracker's closing form (`Fixes <ID>`) and merge's close-out moves it to done. `tracker`: the closing form, but merge leaves the issue to the tracker's own integration with the source-control host (one that moves it to a state of its own, like In QA). `leave`: the linking-only form (`Part of <ID>`) and no close-out, so merging leaves the issue's state alone",
      example: "leave",
      pattern: ISSUE_ON_MERGE,
    },
    {
      key: "requireAllChecks",
      type: "boolean",
      description:
        "Wait on every CI check, not only the ones the base requires, and refuse to merge while any failed or was cancelled (default false: the host decides which failures block). `ready.ignoreChecks` still leaves its checks out",
      example: true,
    },
    {
      key: "unresolvedThreads",
      description:
        "Unresolved review threads that stop a merge: `allow` (the default: only what the host's own rules block), `bots` (any automated reviewer's), or `all` (anyone's)",
      example: "bots",
      pattern: THREADS,
    },
    {
      key: "blockingReviewers",
      type: "string[]",
      description:
        "Logins whose unresolved review threads stop a merge, whatever `unresolvedThreads` says: for a repo where only one automated reviewer's threads should block (`github-advanced-security`, CodeQL's). A login matches a thread's first comment's author, case aside, with or without `[bot]`",
      example: ["github-advanced-security"],
      check: (value) =>
        Array.isArray(value) &&
        value.every((login) => typeof login === "string" && LOGIN.test(login))
          ? undefined
          : "must list logins (`github-advanced-security`, `claude[bot]`)",
    },
    {
      key: "requireClean",
      type: "boolean",
      description:
        "Refuse to merge with uncommitted changes even when the branch has no pull request yet, before merge's own sync could commit them (default false: with no pull request, merge runs sync, which commits what's uncommitted)",
      example: true,
    },
    {
      key: "ciTimeout",
      type: "number",
      description:
        "Minutes merge waits for CI on the commit it lands to settle (default 30)",
      example: 45,
    },
    {
      key: "watchDeploy",
      type: "boolean",
      description:
        "After the merge, watch the deployment of the commit it landed (through the `deployments` integrations) until it succeeds or fails, and report each step (default false)",
      example: true,
    },
    {
      key: "deployTimeout",
      type: "number",
      description:
        "Minutes the deploy watch waits for the deployment to succeed or fail before reporting it still pending (default 30)",
      example: 40,
    },
    {
      key: "deployLogLines",
      type: "number",
      description:
        "When a watched deployment fails, the last this many lines of each failed step's log (through the source-control `checkLog` op) lead the report (unset: no log, only the steps and the deployment's link)",
      example: 120,
    },
    {
      key: "sync",
      description:
        "How merge syncs the branch before its CI wait: `full` (the default) runs the whole sync, which catches the branch up to its base and pushes; `remote` refreshes only the pull request and its issue, so merge pushes nothing, and a branch that's behind, conflicting, or has unpushed commits stops for the user to sync first. `remote` keeps the commit CI and a recorded review saw as the one that lands",
      example: "remote",
      pattern: SYNC,
    },
    {
      key: "requireEvaluation",
      description:
        "Gate the merge on evaluate's recorded verdict (`evaluate.record`) for the commit that lands: `pass` merges only on a pass, and a flag needs the user's explicit go-ahead; `flag` merges on a pass or a flag. No verdict, one on an older commit, or `stop` stops the merge. With `evaluate.scope: delta`, a verdict carries to the head when the branch only took in its base",
      example: "pass",
      pattern: EVALUATION,
    },
    hookField("merge.before"),
    hookField("merge.beforeCi"),
    hookField("merge.after"),
  ],
  lookup:
    "Leave it out when merging needs nothing of the repo's own. Set `requireAllChecks` when the team never merges past a failing check, required or not; `unresolvedThreads` to `bots` when an automated reviewer's open thread should block, or `blockingReviewers` when only some reviewers' should (CodeQL's `github-advanced-security`); `requireClean` when uncommitted work should never ride along with merge's own sync; `ciTimeout` when CI on the landing commit takes longer than 30 minutes; `watchDeploy` when merging to the base deploys, and a merge isn't done until that deploy is, with `deployTimeout` when the deploy can take longer than 30 minutes and `deployLogLines` when a failed step's log says more than its name; `sync` to `remote` when catching up shouldn't happen inside merge (a slow CI run, or a review gate on the head commit). Set `requireEvaluation` when nothing lands without a review of its head (with `evaluate.record`). Set `issueOnMerge` to `tracker` when the tracker's integration with the host moves the issue on merge, `leave` when merging shouldn't move it at all (the team does by hand), `after` for teardown done by hand after a merge today (with `on: success`), `before` for a check that must pass before anything lands, `beforeCi` for a commit that must land with the merge (a changelog entry)",
}

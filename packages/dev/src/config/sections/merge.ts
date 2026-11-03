import { hookField } from "../hooks.ts"
import type { FieldPattern, SectionSpec } from "../types.ts"

const THREADS: FieldPattern = {
  regex: /^(allow|bots|all)$/,
  hint: "`allow`, `bots`, or `all`",
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
      key: "watchDeploy",
      type: "boolean",
      description:
        "After the merge, watch the deployment of the commit it landed (through the `deployments` integrations) until it succeeds or fails, and report each step (default false)",
      example: true,
    },
    hookField("merge.before"),
    hookField("merge.beforeCi"),
    hookField("merge.after"),
  ],
  lookup:
    "Leave it out when merging needs nothing of the repo's own. Set `requireAllChecks` when the team never merges past a failing check, required or not; `unresolvedThreads` to `bots` when an automated reviewer's open thread should block; `watchDeploy` when merging to the base deploys, and a merge isn't done until that deploy is. Set `issueOnMerge` to `tracker` when the tracker's integration with the host moves the issue on merge, `leave` when merging shouldn't move it at all (the team does by hand), `after` for teardown done by hand after a merge today (with `on: success`), `before` for a check that must pass before anything lands, `beforeCi` for a commit that must land with the merge (a changelog entry)",
}

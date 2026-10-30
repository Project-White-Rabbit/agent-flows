import { hookField } from "../hooks.ts"
import type { FieldPattern, SectionSpec } from "../types.ts"

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
    hookField("merge.before"),
    hookField("merge.beforeCi"),
    hookField("merge.after"),
  ],
  lookup:
    "Leave it out when merging needs nothing of the repo's own. Set `issueOnMerge` to `tracker` when the tracker's integration with the host moves the issue on merge, `leave` when merging shouldn't move it at all (the team does by hand), `after` for teardown done by hand after a merge today (with `on: success`), `before` for a check that must pass before anything lands, `beforeCi` for a commit that must land with the merge (a changelog entry)",
}

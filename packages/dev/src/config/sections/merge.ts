import { hookField } from "../hooks.ts"
import type { SectionSpec } from "../types.ts"

export const merge: SectionSpec = {
  path: "merge",
  name: "Merge",
  purpose:
    "Whether merge closes the issue itself, and the repo's own steps before merge lands a branch, before its CI wait, and after, for checks and cleanup no integration covers",
  fields: [
    {
      key: "closeIssue",
      type: "boolean",
      description:
        "Move the pull request's issue to done in merge's close-out (default true). False when the issue tracker's own integration with the source-control host closes it on merge, so merge leaves the issue alone",
      example: false,
    },
    hookField("merge.before"),
    hookField("merge.beforeCi"),
    hookField("merge.after"),
  ],
  lookup:
    "Leave it out when merging needs nothing of the repo's own. Set `closeIssue` to false when the tracker closes the issue itself on merge (its integration with the host), `after` for teardown done by hand after a merge today (with `on: success`), `before` for a check that must pass before anything lands, `beforeCi` for a commit that must land with the merge (a changelog entry)",
}

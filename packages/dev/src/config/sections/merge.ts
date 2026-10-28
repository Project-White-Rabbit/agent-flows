import { hookField } from "../hooks.ts"
import type { SectionSpec } from "../types.ts"

export const merge: SectionSpec = {
  path: "merge",
  name: "Merge hooks",
  purpose:
    "The repo's own steps before merge lands a branch and after, for checks and cleanup no integration covers",
  fields: [hookField("merge.before"), hookField("merge.after")],
  lookup:
    "Leave it out when merging needs nothing of the repo's own. Set `after` for teardown done by hand after a merge today (with `on: success`), `before` for a check that must pass before anything lands",
}

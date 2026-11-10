import { hookField } from "../hooks.ts"
import type { SectionSpec } from "../types.ts"

export const cancel: SectionSpec = {
  path: "cancel",
  name: "Close hooks",
  purpose:
    "The repo's own steps when cancel throws a branch's work away: a check before anything is deleted, and teardown of what the repo set up for the branch",
  fields: [hookField("cancel.before"), hookField("cancel.after")],
  lookup:
    "Leave it out when abandoning a branch leaves nothing of the repo's own behind. Set `after` for what's torn down by hand today (a database branch, dev servers, a marker a worktree setup script reads), usually the same as `finish.after`",
}

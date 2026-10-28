import { hookField } from "../hooks.ts"
import type { SectionSpec } from "../types.ts"

export const hooks: SectionSpec = {
  path: "hooks",
  name: "General hooks",
  purpose:
    "The repo's own steps around every dev-flows command but configure; a flow's own steps are in its section (`ready`, `merge`)",
  fields: [hookField("hooks.before"), hookField("hooks.after")],
  lookup:
    "Leave it out unless something must happen around every command: setting up the worktree's environment before, a notification after. A step for one flow goes in that flow's section",
}

import type { IntegrationSpec } from "../types.ts"
import { VISIBILITY } from "./patterns.ts"

export const lore: IntegrationSpec = {
  path: "integrations.lore",
  name: "Lore",
  purpose:
    "Share the agent session behind a change, linked from its PR and issue",
  fields: [
    {
      key: "visibility",
      description:
        "Who can open a shared session: private, workspace, or public",
      example: "workspace",
      required: true,
      pattern: VISIBILITY,
    },
  ],
  lookup: "Ask; `workspace` lets everyone in the team's Lore workspace open it",
  access: {
    mcp: { server: "lore-local" },
  },
  provides: {
    sessions: {
      shareSession: {
        mcp: "The Lore plugin's `share_session` with exactly `{ visibility: {visibility} }`: it finds the active session on disk and uploads it, so don't read the session or pass `session_id`. It returns `thread_url`. When it says sign-in is needed, call its `lore_login` once and retry only if that succeeds. When it rejects `visibility` as unknown, the plugin is too old: don't retry without it, which would share privately; the fix is updating the Lore plugin",
      },
    },
  },
}

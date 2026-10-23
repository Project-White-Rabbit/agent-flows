import type { IntegrationSpec } from "../types.ts"

export const slack: IntegrationSpec = {
  path: "integrations.slack",
  name: "Slack",
  purpose: "Where dev flows post announcements and alerts",
  fields: [
    {
      key: "channel",
      description: "Channel name or id",
      example: "#eng",
      required: true,
    },
  ],
  multiple: true,
  lookup: "Slack MCP (search channels), or ask",
  provides: { chat: {} },
  detect(ctx) {
    const evidence = ctx.dependsOn(/^@slack\//)
    return evidence.length > 0 ? { values: {}, evidence } : undefined
  },
}

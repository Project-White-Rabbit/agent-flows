import type { SectionSpec } from "../types.ts"

export const slack: SectionSpec = {
  path: "services.slack",
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
  lookup: "Slack MCP (search channels), or ask",
  detect(ctx) {
    const evidence = ctx.dependsOn(/^@slack\//)
    return evidence.length > 0 ? { values: {}, evidence } : undefined
  },
}

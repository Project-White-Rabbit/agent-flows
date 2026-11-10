import type { IntegrationSpec } from "../../config/types.ts"

export const slack: IntegrationSpec = {
  path: "integrations.slack",
  name: "Slack",
  purpose: "Where dev flows post announcements and alerts",
  fields: [
    {
      key: "channel",
      description: "The team's channel: a name or channel id, never a DM",
      example: "#eng",
      required: true,
      // A DM or a person's id posts somewhere only one teammate reads.
      warn: (value) =>
        /^@|^[DUW][A-Z0-9]{8,}$/.test(String(value))
          ? "is a direct message or a person, not a channel the team reads: use a channel's name or id (`#eng`, `C…`)"
          : undefined,
    },
  ],
  multiple: true,
  lookup:
    "Slack MCP (search channels), or ask: a channel the team reads, never a DM or a person",
  access: {
    mcp: { server: "Slack" },
    api: {
      base: "https://slack.com/api",
      token: ["SLACK_BOT_TOKEN", "SLACK_TOKEN"],
    },
  },
  provides: { chat: {} },
  detect(ctx) {
    const evidence = ctx.dependsOn(/^@slack\//)
    return evidence.length > 0 ? { values: {}, evidence } : undefined
  },
}

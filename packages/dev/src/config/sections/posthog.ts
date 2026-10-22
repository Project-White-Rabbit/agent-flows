import type { SectionSpec, SectionValues } from "../types.ts"

export const posthog: SectionSpec = {
  path: "services.posthog",
  name: "PostHog",
  purpose: "Product analytics, feature flags, session replay",
  fields: [
    {
      key: "projectId",
      description: "Numeric project id",
      example: "12345",
      required: true,
    },
    { key: "host", description: "App host", example: "https://us.posthog.com" },
  ],
  lookup: "PostHog MCP (list projects)",
  detect(ctx) {
    const evidence = ctx.dependsOn(
      /^(posthog-js|posthog-node|posthog-react-native|posthog)$/,
    )
    const values: SectionValues = {}
    for (const { file, text } of ctx.envTemplates) {
      const host = text.match(
        /^\s*\w*POSTHOG_HOST\s*=\s*["']?(https?:\/\/[^"'\s]+)/m,
      )
      if (host) {
        evidence.push(`${file} sets a PostHog host`)
        values.host ??= host[1]
      } else if (/POSTHOG/.test(text)) {
        evidence.push(`${file} has PostHog variables`)
      }
    }
    return evidence.length > 0 ? { values, evidence } : undefined
  },
}

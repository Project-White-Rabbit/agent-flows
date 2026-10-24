import type { IntegrationSpec, SectionValues } from "../types.ts"
import { SLUG } from "./patterns.ts"

/** `defaults.org=acme` (sentry.properties) or `[defaults]\norg=acme` (.sentryclirc). */
export function parseSentryConfig(text: string): SectionValues {
  const out: SectionValues = {}
  let section = ""
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    const header = line.match(/^\[(.+)\]$/)
    if (header) {
      section = header[1]
      continue
    }
    const pair = line.match(/^([\w.]+)\s*=\s*(.+)$/)
    if (!pair) {
      continue
    }
    const key = pair[1].includes(".") ? pair[1] : `${section}.${pair[1]}`
    if (key === "defaults.org") {
      out.org = pair[2]
    } else if (key === "defaults.project") {
      out.project = pair[2]
    } else if (key === "defaults.url") {
      out.url = pair[2]
    }
  }
  return out
}

export const sentry: IntegrationSpec = {
  path: "integrations.sentry",
  name: "Sentry",
  purpose: "Production errors behind a bug",
  fields: [
    {
      key: "org",
      description: "Organization slug",
      example: "acme",
      required: true,
      pattern: SLUG,
    },
    {
      key: "project",
      description: "Project slug",
      example: "web",
      required: true,
      pattern: SLUG,
    },
    {
      key: "url",
      description: "Self-hosted base URL",
      example: "https://sentry.acme.dev",
    },
  ],
  multiple: true,
  lookup: "Sentry MCP (find projects), or `sentry-cli projects list`",
  access: {
    mcp: { server: "Sentry" },
    cli: { bin: "sentry-cli", auth: ["sentry-cli", "info"] },
    api: {
      base: "https://sentry.io/api/0 (or `<url>/api/0` on a self-hosted `url`)",
      token: ["SENTRY_AUTH_TOKEN"],
    },
  },
  provides: {
    errorTracking: {
      issueRef:
        "A short id like `WEB-4P`, or an issue URL: `https://{org}.sentry.io/issues/<id>/`, or `<base>/organizations/{org}/issues/<id>/` on a self-hosted `url`",
      resolveIssue: {
        mcp: "The Sentry MCP's `update_issue` for `<issue>` in organization `{org}` with `status: resolved`",
        cli: "`sentry-cli issues --org {org} --project {project} resolve --id <issue>` (the numeric id; look a short id up with the API or MCP first)",
        api: '`curl -fsSL -X PUT -H "Authorization: Bearer {token}" -H "Content-Type: application/json" -d \'{"status":"resolved"}\' "https://sentry.io/api/0/organizations/{org}/issues/<issue>/"` (the base is `<url>/api/0` on a self-hosted `url`)',
      },
    },
  },
  detect(ctx) {
    const evidence: string[] = []
    let values: SectionValues = {}
    for (const file of ctx.tracked.filter((f) =>
      /(^|\/)(sentry\.properties|\.sentryclirc)$/.test(f),
    )) {
      evidence.push(file)
      values = { ...parseSentryConfig(ctx.read(file) ?? ""), ...values }
    }
    evidence.push(...ctx.dependsOn(/^(@sentry\/|sentry-sdk$)/))
    for (const { file, text } of ctx.envTemplates) {
      if (/SENTRY/.test(text)) {
        evidence.push(`${file} has Sentry variables`)
      }
    }
    return evidence.length > 0 ? { values, evidence } : undefined
  },
}

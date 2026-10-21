import type { SectionSpec, SectionValues } from "../types.ts"

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

export const sentry: SectionSpec = {
  path: "services.sentry",
  name: "Sentry",
  purpose: "Production errors behind a bug",
  fields: [
    {
      key: "org",
      description: "Organization slug",
      example: "acme",
      required: true,
    },
    {
      key: "project",
      description: "Project slug",
      example: "web",
      required: true,
    },
    {
      key: "url",
      description: "Self-hosted base URL",
      example: "https://sentry.acme.dev",
    },
  ],
  lookup: "Sentry MCP (find projects), or `sentry-cli projects list`",
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

import type { SectionSpec, SectionValues } from "../types.ts"

// Key-shaped tokens that aren't ticket prefixes.
const NOT_TEAM_KEYS = new Set(["UTF", "ISO", "ES", "SHA", "RFC", "CVE", "HTTP"])

/**
 * The most common `KEY-123` prefix across branch names and commit subjects, if
 * it shows up often enough to be a ticket convention rather than noise.
 */
export function inferLinearTeamKey(
  texts: string[],
  minHits = 3,
): { key: string; hits: number } | undefined {
  const counts = new Map<string, number>()
  for (const text of texts) {
    for (const match of text.matchAll(/\b([A-Za-z][A-Za-z0-9]{1,6})-\d+\b/g)) {
      const key = match[1].toUpperCase()
      if (!NOT_TEAM_KEYS.has(key)) {
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  let best: { key: string; hits: number } | undefined
  for (const [key, hits] of counts) {
    if (!best || hits > best.hits) {
      best = { key, hits }
    }
  }
  return best && best.hits >= minHits ? best : undefined
}

export const linear: SectionSpec = {
  path: "services.linear",
  name: "Linear",
  purpose: "Tickets: link branches and PRs, file and close issues",
  fields: [
    {
      key: "teamKey",
      description: "Issue key prefix",
      example: "ENG",
      required: true,
    },
    {
      key: "workspace",
      description: "URL slug in linear.app/<slug>",
      example: "acme",
    },
  ],
  lookup: "Linear MCP (list teams)",
  detect(ctx) {
    const refs = (
      ctx.git([
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
      ]) ?? ""
    ).split("\n")
    const subjects = (ctx.git(["log", "-300", "--format=%s"]) ?? "").split("\n")
    const evidence = ctx.dependsOn(/^@linear\//)
    const team = inferLinearTeamKey([...refs, ...subjects])
    if (team) {
      evidence.unshift(
        `${team.hits} branch names or commit subjects reference ${team.key}-<n>`,
      )
    }
    const values: SectionValues = team ? { teamKey: team.key } : {}
    return evidence.length > 0 ? { values, evidence } : undefined
  },
}

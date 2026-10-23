import type { IntegrationSpec, SectionValues } from "../types.ts"

const BROWSE_LINK =
  /\b([a-z0-9-]+\.atlassian\.net)\/browse\/([A-Z][A-Z0-9_]+)-\d+/g

/** Every project key a `<site>.atlassian.net/browse/KEY-123` link names. */
export function jiraLinkedKeys(texts: string[]): Set<string> {
  return new Set(
    texts.flatMap((text) => [...text.matchAll(BROWSE_LINK)].map((m) => m[2])),
  )
}

/**
 * The most common `<site>.atlassian.net/browse/KEY-123` link across commit
 * messages: the Jira site and project the team links work to.
 */
export function inferJiraProject(
  texts: string[],
): { site: string; projectKey: string; hits: number } | undefined {
  const counts = new Map<string, number>()
  for (const text of texts) {
    for (const match of text.matchAll(BROWSE_LINK)) {
      const key = `${match[1]} ${match[2]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let best: { site: string; projectKey: string; hits: number } | undefined
  for (const [key, hits] of counts) {
    if (!best || hits > best.hits) {
      const [site, projectKey] = key.split(" ")
      best = { site, projectKey, hits }
    }
  }
  return best
}

export const jira: IntegrationSpec = {
  path: "integrations.jira",
  name: "Jira",
  purpose: "Tickets: link branches and PRs, file and close issues",
  fields: [
    {
      key: "site",
      description: "Atlassian site host",
      example: "acme.atlassian.net",
      required: true,
    },
    {
      key: "projectKey",
      description: "Issue key prefix",
      example: "ENG",
      required: true,
    },
  ],
  multiple: true,
  lookup: "Atlassian MCP (list projects), or ask",
  provides: { issueTracker: {} },
  detect(ctx) {
    const messages = (ctx.git(["log", "-300", "--format=%B"]) ?? "").split("\n")
    const evidence = ctx.dependsOn(/^(jira-client|jira\.js|jira)$/)
    const project = inferJiraProject(messages)
    let values: SectionValues = {}
    if (project) {
      evidence.unshift(
        `${project.hits} commit message(s) link ${project.site}/browse/${project.projectKey}-<n>`,
      )
      values = { site: project.site, projectKey: project.projectKey }
    }
    return evidence.length > 0 ? { values, evidence } : undefined
  },
}

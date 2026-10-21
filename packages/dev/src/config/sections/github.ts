import type { SectionSpec } from "../types.ts"

export function parseGithubRemote(
  url: string,
): { owner: string; repo: string } | undefined {
  const match = url
    .trim()
    .match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return match ? { owner: match[1], repo: match[2] } : undefined
}

export const github: SectionSpec = {
  path: "services.github",
  name: "GitHub",
  purpose: "Pull requests, CI checks, code review",
  fields: [
    {
      key: "owner",
      description: "Org or user",
      example: "acme",
      required: true,
    },
    {
      key: "repo",
      description: "Repository name",
      example: "web",
      required: true,
    },
  ],
  lookup: "`gh repo view --json owner,name`",
  detect(ctx) {
    const remote = ctx.git(["remote", "get-url", "origin"])
    const parsed = remote ? parseGithubRemote(remote) : undefined
    return parsed
      ? { values: parsed, evidence: [`origin remote ${remote}`] }
      : undefined
  },
}

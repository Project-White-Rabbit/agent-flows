import type { IntegrationSpec } from "../types.ts"
import { SLUG } from "./patterns.ts"

const PR_JSON =
  "number,url,title,body,state,isDraft,baseRefName,headRefName,additions,deletions,changedFiles"

export function parseGithubRemote(
  url: string,
): { owner: string; repo: string } | undefined {
  const match = url
    .trim()
    .match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return match ? { owner: match[1], repo: match[2] } : undefined
}

export const github: IntegrationSpec = {
  path: "integrations.github",
  name: "GitHub",
  purpose: "Pull requests, CI checks, code review",
  fields: [
    {
      key: "owner",
      description: "Org or user",
      example: "acme",
      required: true,
      pattern: SLUG,
    },
    {
      key: "repo",
      description: "Repository name",
      example: "web",
      required: true,
      pattern: SLUG,
    },
  ],
  multiple: true,
  lookup: "`gh repo view --json owner,name`",
  provides: {
    sourceControl: {
      prRef: "A bare number, or `https://github.com/{owner}/{repo}/pull/<N>`",
      currentPr: `\`gh pr view "$(git branch --show-current)" --repo {owner}/{repo} --json ${PR_JSON}\``,
      prMetadata: `\`gh pr view <N> --repo {owner}/{repo} --json ${PR_JSON}\``,
      prDiff: "`gh pr diff <N> --repo {owner}/{repo}`",
      prFiles: "`gh pr diff <N> --repo {owner}/{repo} --name-only`",
      prCommits:
        "`gh pr view <N> --repo {owner}/{repo} --json commits -q '.commits[].messageHeadline'`",
    },
  },
  detect(ctx) {
    const remote = ctx.git(["remote", "get-url", "origin"])
    const parsed = remote ? parseGithubRemote(remote) : undefined
    return parsed
      ? { values: parsed, evidence: [`origin remote ${remote}`] }
      : undefined
  },
}

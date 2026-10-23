import type { IntegrationSpec } from "../types.ts"
import { SLUG } from "./patterns.ts"

const PR_JSON =
  "number,url,title,body,state,isDraft,baseRefName,headRefName,additions,deletions,changedFiles"

const PR_FIELDS =
  "number, URL, title, body, state, draft, base and head branches, additions, deletions, and changed files"

// The REST API, authenticated from the token's variable. Each opens a quoted
// URL the op closes, so a shell expansion can sit inside it.
const AUTH =
  '-H "Authorization: Bearer {token}" -H "Accept: application/vnd.github+json"'
const API = `\`curl -fsSL ${AUTH} "https://api.github.com/repos/{owner}/{repo}`
const API_DIFF = `\`curl -fsSL -H "Authorization: Bearer {token}" -H "Accept: application/vnd.github.diff" "https://api.github.com/repos/{owner}/{repo}`
const API_BARE = `\`https://api.github.com/repos/{owner}/{repo}`

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
  lookup:
    "`gh repo view --json owner,name`, or the GitHub MCP's repository search",
  access: {
    mcp: { server: "GitHub" },
    cli: { bin: "gh", auth: ["gh", "auth", "status"] },
    api: {
      base: "https://api.github.com",
      token: ["GITHUB_TOKEN", "GH_TOKEN"],
    },
  },
  provides: {
    sourceControl: {
      prRef: "A bare number, or `https://github.com/{owner}/{repo}/pull/<N>`",
      currentPr: {
        mcp: `The GitHub MCP's \`list_pull_requests\` for {owner}/{repo} with \`head: {owner}:<branch>\` and \`state: all\`, the most recent; then its pull request read tool for ${PR_FIELDS}`,
        cli: `\`gh pr view "$(git branch --show-current)" --repo {owner}/{repo} --json ${PR_JSON}\``,
        api: `${API}/pulls?state=all&head={owner}:$(git branch --show-current)"\`, the most recent; then \`prMetadata\` for its counts`,
      },
      prMetadata: {
        mcp: `The GitHub MCP's pull request read tool (\`pull_request_read\` with \`method: get\`, or \`get_pull_request\`) for {owner}/{repo} #<N>: ${PR_FIELDS}`,
        cli: `\`gh pr view <N> --repo {owner}/{repo} --json ${PR_JSON}\``,
        api: `${API}/pulls/<N>"\`: a set \`merged_at\` means merged`,
      },
      prDiff: {
        mcp: "The GitHub MCP's pull request read tool (`pull_request_read` with `method: get_diff`, or `get_pull_request_diff`) for {owner}/{repo} #<N>",
        cli: "`gh pr diff <N> --repo {owner}/{repo}`",
        api: `${API_DIFF}/pulls/<N>"\``,
      },
      prFiles: {
        mcp: "The GitHub MCP's pull request read tool (`pull_request_read` with `method: get_files`, or `get_pull_request_files`) for {owner}/{repo} #<N>, each `filename`",
        cli: "`gh pr diff <N> --repo {owner}/{repo} --name-only`",
        api: `${API}/pulls/<N>/files?per_page=100"\` (follow the \`Link\` header's next pages), each \`filename\``,
      },
      prCommits: {
        mcp: "The GitHub MCP's pull request read tool (`pull_request_read` with `method: get_commits`) for {owner}/{repo} #<N>, each message's first line",
        cli: "`gh pr view <N> --repo {owner}/{repo} --json commits -q '.commits[].messageHeadline'`",
        api: `${API}/pulls/<N>/commits?per_page=100"\`, each \`commit.message\`'s first line`,
      },
      prCreate: {
        mcp: "The GitHub MCP's `create_pull_request` for {owner}/{repo} with `head` the checked-out branch, `base: <base>`, `title: <title>`, `body` the contents of <body-file>, and `draft: true`",
        cli: '`gh pr create --repo {owner}/{repo} --draft --base <base> --head "$(git branch --show-current)" --title <title> --body-file <body-file>`',
        api: `\`POST\` ${API_BARE}/pulls\` (header \`Authorization: Bearer {token}\`) with JSON \`title\`, \`head\` (the checked-out branch), \`base\`, \`body\` (the file's contents), and \`draft: true\``,
      },
      prEdit: {
        mcp: "The GitHub MCP's `update_pull_request` for {owner}/{repo} #<N> with `title: <title>` and `body` the contents of <body-file>",
        cli: "`gh pr edit <N> --repo {owner}/{repo} --title <title> --body-file <body-file>`",
        api: `\`PATCH\` ${API_BARE}/pulls/<N>\` (header \`Authorization: Bearer {token}\`) with JSON \`title\` and \`body\` (the file's contents)`,
      },
      prMergeability: {
        mcp: "The GitHub MCP's pull request read tool for {owner}/{repo} #<N>: `mergeable` false is conflicting, `mergeable_state` `behind` is behind, `mergeable` null is pending, anything else is clean",
        cli: "`gh pr view <N> --repo {owner}/{repo} --json mergeable,mergeStateStatus`: `CONFLICTING` or `DIRTY` is conflicting, `BEHIND` is behind, an `UNKNOWN` `mergeable` is pending, anything else is clean",
        api: `${API}/pulls/<N>"\`: \`mergeable\` false is conflicting, \`mergeable_state\` \`behind\` is behind, \`mergeable\` null is pending, anything else is clean`,
      },
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

import type { IntegrationSpec } from "../types.ts"
import { HOST, SLUG_PATH } from "./patterns.ts"

/**
 * `git@gitlab.com:group/sub/web.git`, `https://gitlab.acme.dev:8443/group/web`,
 * …: a remote whose host contains "gitlab". `host` is set only when it isn't
 * gitlab.com, with the port for HTTP remotes (an SSH port isn't the web's). A
 * dotless host is an SSH alias from ~/.ssh/config, whose real host is unknown,
 * so it comes back as `alias` instead.
 */
export function parseGitlabRemote(
  url: string,
): { project: string; host?: string; alias?: string } | undefined {
  const text = url.trim()
  let host: string
  let port = ""
  let path: string
  let ssh: boolean
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      return undefined
    }
    host = parsed.hostname
    port = parsed.port
    path = decodeURIComponent(parsed.pathname)
    ssh = /ssh/.test(parsed.protocol)
  } else {
    const scp = text.match(/^(?:[^@\s/]+@)?([^:\s/]+):([^\s]+)$/)
    if (!scp) {
      return undefined
    }
    ;[, host, path] = scp
    ssh = true
  }
  host = host.toLowerCase()
  const project = path.replace(/^\/+/, "").replace(/(\.git)?\/?$/, "")
  if (!host.includes("gitlab") || !SLUG_PATH.regex.test(project)) {
    return undefined
  }
  if (host === "gitlab.com") {
    return { project }
  }
  if (!host.includes(".")) {
    return { project, alias: host }
  }
  return { project, host: port && !ssh ? `${host}:${port}` : host }
}

// Every op names its project with `-R`, so each instance reads its own, and
// `{host|gitlab.com}` makes the same command right for self-managed hosts.
const REPO = "-R https://{host|gitlab.com}/{project}"

// The REST API, authenticated from the token's variable. Each opens a quoted
// URL the op closes, so a shell expansion can sit inside it.
const API_BARE = "`https://{host|gitlab.com}/api/v4/projects/{project:encoded}"
const API = `\`curl -fsSL -H "PRIVATE-TOKEN: {token}" "https://{host|gitlab.com}/api/v4/projects/{project:encoded}`

const KEEP_DRAFT =
  "GitLab marks drafts by a `Draft: ` title prefix, so keep it on a draft's <title>"

const MERGE_STATUS =
  "`has_conflicts` true is conflicting; a `detailed_merge_status` of `need_rebase` is behind, and `checking`, `unchecked`, or `preparing` is pending; anything else is clean"

const MR_FIELDS =
  "`iid`, `web_url`, `title`, `description`, `state`, `draft`, `target_branch`, `source_branch`, `changes_count`; count additions and deletions from the diff"

export const gitlab: IntegrationSpec = {
  path: "integrations.gitlab",
  name: "GitLab",
  purpose: "Merge requests, CI pipelines, code review",
  fields: [
    {
      key: "project",
      description: "Project path, including groups",
      example: "acme/web",
      required: true,
      pattern: SLUG_PATH,
    },
    {
      key: "host",
      description: "Self-managed host name",
      example: "gitlab.acme.dev",
      pattern: HOST,
    },
  ],
  multiple: true,
  lookup: "`glab repo view`, or the GitLab MCP",
  access: {
    mcp: { server: "GitLab" },
    cli: { bin: "glab", auth: ["glab", "auth", "status"] },
    api: {
      base: "https://<host>/api/v4 (gitlab.com unless `host` is set)",
      token: ["GITLAB_TOKEN"],
    },
  },
  provides: {
    sourceControl: {
      prRef:
        "A bare number, or `https://{host|gitlab.com}/{project}/-/merge_requests/<N>`",
      currentPr: {
        mcp: `The GitLab MCP's merge request search for project \`{project}\` with source branch \`<branch>\`, the most recent: ${MR_FIELDS}`,
        cli: `\`glab mr view "$(git branch --show-current)" ${REPO} --output json\`: ${MR_FIELDS}`,
        api: `${API}/merge_requests?source_branch=$(git branch --show-current)&order_by=updated_at"\`, the first: ${MR_FIELDS}`,
      },
      prMetadata: {
        mcp: `The GitLab MCP's merge request read tool for project \`{project}\` !<N>: ${MR_FIELDS}`,
        cli: `\`glab mr view <N> ${REPO} --output json\`: ${MR_FIELDS}`,
        api: `${API}/merge_requests/<N>"\`: ${MR_FIELDS}`,
      },
      prDiff: {
        mcp: "The GitLab MCP's merge request diffs tool for project `{project}` !<N>",
        cli: `\`glab mr diff <N> ${REPO} --raw\``,
        api: `${API}/merge_requests/<N>/raw_diffs"\``,
      },
      prFiles:
        "The `b/` paths of the `diff --git` lines in the `prDiff` output",
      prCommits: {
        mcp: "The GitLab MCP's merge request commits tool for project `{project}` !<N>, each commit's `title`",
        cli: "`glab api projects/{project:encoded}/merge_requests/<N>/commits --hostname {host|gitlab.com} --paginate`, each commit's `title`",
        api: `${API}/merge_requests/<N>/commits?per_page=100"\`, each commit's \`title\``,
      },
      prCreate: {
        mcp: "The GitLab MCP's create merge request tool for project `{project}`: source branch the checked-out branch, target `<base>`, title `Draft: <title>`, description the contents of <body-file>",
        cli: `\`glab mr create ${REPO} --draft --target-branch <base> --source-branch "$(git branch --show-current)" --title <title> --description "$(cat <body-file>)" --yes\``,
        api: `\`POST\` ${API_BARE}/merge_requests\` (header \`PRIVATE-TOKEN: {token}\`) with JSON \`source_branch\` (the checked-out branch), \`target_branch\`, \`title\` (\`Draft: <title>\`), and \`description\` (the file's contents)`,
      },
      prEdit: {
        mcp: `The GitLab MCP's update merge request tool for project \`{project}\` !<N> with the title and the contents of <body-file> as description. ${KEEP_DRAFT}`,
        cli: `\`glab mr update <N> ${REPO} --title <title> --description "$(cat <body-file>)"\`. ${KEEP_DRAFT}`,
        api: `\`PUT\` ${API_BARE}/merge_requests/<N>\` (header \`PRIVATE-TOKEN: {token}\`) with JSON \`title\` and \`description\` (the file's contents). ${KEEP_DRAFT}`,
      },
      prMergeability: {
        mcp: `The GitLab MCP's merge request read tool for project \`{project}\` !<N>: ${MERGE_STATUS}`,
        cli: `\`glab mr view <N> ${REPO} --output json\`: ${MERGE_STATUS}`,
        api: `${API}/merge_requests/<N>"\`: ${MERGE_STATUS}`,
      },
    },
  },
  detect(ctx) {
    const remote = ctx.git(["remote", "get-url", "origin"])
    const parsed = remote ? parseGitlabRemote(remote) : undefined
    if (!parsed) {
      return undefined
    }
    const { alias, ...values } = parsed
    const evidence = [`origin remote ${remote}`]
    if (alias) {
      evidence.push(
        `origin uses the SSH alias ${alias}: set host if it points at a self-managed GitLab`,
      )
    }
    return { values, evidence }
  },
}

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
  lookup: "`glab repo view`",
  provides: {
    sourceControl: {
      prRef:
        "A bare number, or `https://{host|gitlab.com}/{project}/-/merge_requests/<N>`",
      currentPr: `\`glab mr view "$(git branch --show-current)" ${REPO} --output json\`: ${MR_FIELDS}`,
      prMetadata: `\`glab mr view <N> ${REPO} --output json\`: ${MR_FIELDS}`,
      prDiff: `\`glab mr diff <N> ${REPO} --raw\``,
      prFiles:
        "The `b/` paths of the `diff --git` lines in the `prDiff` output",
      prCommits:
        "`glab api projects/{project:encoded}/merge_requests/<N>/commits --hostname {host|gitlab.com} --paginate`, each commit's `title`",
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

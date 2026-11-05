import type {
  DetectContext,
  Detection,
  IntegrationSpec,
} from "../../config/types.ts"
import { parseGithubRemote } from "../github/spec.ts"
import { BOT_LOGIN, MENTION, SLUG, WORKFLOW_FILE } from "../patterns.ts"
import {
  DEFAULT_BOT,
  DEFAULT_MENTION,
  requestReview,
  reviewResult,
} from "./adapter.ts"

const ACTION = "anthropics/claude-code-action"

/**
 * The workflow that runs Claude Code's action when a comment mentions it, and
 * the mention it wakes on (its `trigger_phrase`, else `@claude`). A workflow
 * that runs the action only on pushes or new pull requests reviews by itself,
 * so there's nothing to request: it isn't one.
 */
export function claudeWorkflow(
  file: string,
  text: string,
): { workflow: string; mention: string } | undefined {
  if (!text.includes(ACTION) || !/^\s*issue_comment\s*:/m.test(text)) {
    return undefined
  }
  const phrase = text.match(/^\s*trigger_phrase\s*:\s*["']?(@[^\s"']+)/m)?.[1]
  const mention =
    phrase && MENTION.regex.test(phrase) ? phrase : DEFAULT_MENTION
  return { workflow: file.split("/").at(-1) as string, mention }
}

function detect(ctx: DetectContext): Detection | undefined {
  const remote = ctx.git(["remote", "get-url", "origin"])
  const repo = remote ? parseGithubRemote(remote) : undefined
  if (!repo) {
    return undefined
  }
  for (const file of ctx.tracked) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) {
      continue
    }
    const found = claudeWorkflow(file, ctx.read(file) ?? "")
    if (found && WORKFLOW_FILE.regex.test(found.workflow)) {
      return {
        values: {
          ...repo,
          workflow: found.workflow,
          ...(found.mention === DEFAULT_MENTION
            ? {}
            : { mention: found.mention }),
        },
        evidence: [
          `${file} runs ${ACTION} when a comment mentions ${found.mention}`,
        ],
      }
    }
  }
  return undefined
}

const RUNS =
  "`gh api 'repos/{owner}/{repo}/actions/workflows/{workflow}/runs?event=issue_comment&per_page=100'`: of the runs created at or after <requested> whose `conclusion` isn't `skipped`, the earliest whose `display_title` is the pull request's title (`gh pr view <pr> --repo {owner}/{repo} --json title`), else the earliest of any (say it may be someone else's)"

export const claude: IntegrationSpec = {
  path: "integrations.claude",
  name: "Claude Code (GitHub Actions)",
  purpose:
    "Reviews a pull request when a comment mentions it, through the repo's Claude Code workflow",
  fields: [
    {
      key: "owner",
      description: "GitHub org or user the workflow runs in",
      example: "acme",
      required: true,
      pattern: SLUG,
    },
    {
      key: "repo",
      description: "GitHub repository the workflow runs in",
      example: "web",
      required: true,
      pattern: SLUG,
    },
    {
      key: "workflow",
      description:
        "The workflow file in `.github/workflows` that runs Claude Code when a comment mentions it",
      example: "claude.yml",
      required: true,
      pattern: WORKFLOW_FILE,
    },
    {
      key: "mention",
      description: `What a comment says to wake it (the workflow's \`trigger_phrase\`; default \`${DEFAULT_MENTION}\`)`,
      example: DEFAULT_MENTION,
      pattern: MENTION,
    },
    {
      key: "bot",
      description: `The login its replies are posted as (default \`${DEFAULT_BOT}\`; a custom GitHub App's own)`,
      example: DEFAULT_BOT,
      pattern: BOT_LOGIN,
    },
  ],
  lookup:
    "The repository from `gh repo view --json owner,name`; the workflow is the file in `.github/workflows` that uses `anthropics/claude-code-action` on `issue_comment`",
  access: {
    cli: { bin: "gh", auth: ["gh", "auth", "status"] },
  },
  provides: {
    codeReview: {
      // Also adapters (`adapters/claude.ts`), run first.
      requestReview: {
        cli: `\`gh pr comment <pr> --repo {owner}/{repo} --body '<mention> review this pull request at <sha>. Focus on correctness bugs, unhandled edge cases, and anything that would break in production, and point at file:line for each finding.'\`, \`<mention>\` the entry's \`mention\` (\`${DEFAULT_MENTION}\` when it has none), then \`gh api 'repos/{owner}/{repo}/issues/<pr>/comments?per_page=100' --jq '.[-1] | {requested: .created_at, url: .html_url}'\` for the comment it posted (follow the \`Link\` header to the last page when there are more than 100)`,
      },
      reviewResult: {
        cli: `The run: ${RUNS}. No run and more than 3 minutes since <requested> is \`skipped\` when a run created since then on the pull request (by \`display_title\`) has \`conclusion\` \`skipped\` (its link is \`run\`), else \`missing\`; a run not \`completed\` is \`pending\`; \`conclusion\` \`success\` is \`done\`, anything else \`failed\`. Findings: the comments in \`gh api --paginate 'repos/{owner}/{repo}/issues/<pr>/comments?per_page=100'\` and the reviews in \`gh api --paginate 'repos/{owner}/{repo}/pulls/<pr>/reviews?per_page=100'\` whose author is the entry's \`bot\` (\`${DEFAULT_BOT}\` when it has none), posted at or after <requested> (\`created_at\`, a review's \`submitted_at\`), with a body; \`inline\` the number of its comments in \`gh api --paginate 'repos/{owner}/{repo}/pulls/<pr>/comments?per_page=100'\` posted since then`,
      },
    },
  },
  adapters: { requestReview, reviewResult },
  detect,
}

import { checks } from "../adapters/github.ts"
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
const SEARCH = `\`curl -fsSL ${AUTH} "https://api.github.com/search/issues?per_page=100&q=`
const GRAPHQL =
  "`POST https://api.github.com/graphql` (header `Authorization: Bearer {token}`)"

// One query for everything getIssue reports, since neither `gh issue view`
// nor the REST issue has the parent and the pull requests that close it.
const ISSUE_QUERY =
  "query($owner: String!, $repo: String!, $n: Int!) { repository(owner: $owner, name: $repo) { issue(number: $n) { number title url body state stateReason labels(first: 20) { nodes { name } } assignees(first: 5) { nodes { login } } parent { number } subIssues(first: 50) { nodes { number title state labels(first: 20) { nodes { name } } milestone { dueOn } } } closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { url } } } } }"
// assignedIssues in one query: neither `gh issue list` nor REST says whether
// an issue has open sub-issues, a closing pull request, or blocks another.
const ASSIGNED_QUERY =
  "query($q: String!, $after: String) { search(type: ISSUE, query: $q, first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on Issue { number title url body labels(first: 20) { nodes { name } } milestone { dueOn } subIssuesSummary { total completed } closedByPullRequestsReferences(first: 5) { nodes { url } } issueDependenciesSummary { blocking } } } } }"
const ASSIGNED =
  "with `q` `repo:{owner}/{repo} is:issue is:open assignee:@me`, following `endCursor` while `hasNextPage`. Its id is `#<number>` and its state `open`; it has open sub-issues when `subIssuesSummary.completed` is below `total`, and blocks another issue when `issueDependenciesSummary.blocking` is above 0. Its priority comes from a priority label (`P0` to `P3`, `priority: high`), else `none`, and its due date from its milestone's `dueOn`, else none"
const ISSUE_NOT_FOUND =
  "Its open sub-issues are the `subIssues` whose `state` is `OPEN`, their priority from a priority label and due date from the milestone's `dueOn`, as for assignedIssues. `Could not resolve to an Issue` (a pull request's number, or none) means there is none. Its project is separate, since reading projects needs the `read:project` token scope: `gh issue view <N> --repo {owner}/{repo} --json projectItems`, only when a flow needs it; when that fails, treat the project as unknown and leave it alone"

const BRANCH_MATCH =
  "Keep only issues whose body has a `> Branch:` line that is `<branch>` once backticks are dropped and any link is read as its text"

// The fields sync and create-tickets set beyond title and body. GitHub's
// issues have no priority, estimate, cycle, or due date of their own.
// Review threads and their comments, which only GraphQL has. Threads past
// the first 100 are rare enough to page by hand.
const THREADS_QUERY =
  "query($owner: String!, $repo: String!, $n: Int!, $after: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $n) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id isResolved path line comments(first: 20) { nodes { author { login __typename } body } } } } } } }"
const THREADS =
  "Keep the threads whose `isResolved` is false, following `endCursor` while `hasNextPage`. An author is a bot when its `__typename` is `Bot` or its login ends in `[bot]`"
const RESOLVE_MUTATION =
  "mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }"
// mergeStateStatus (CLI) and mergeable_state (REST, MCP) name the same states.
const MERGE_STATE =
  "`CLEAN`, `HAS_HOOKS`, or `UNSTABLE` (only checks the base doesn't require are failing) is ready; `BLOCKED` is blocked, by the review when `reviewDecision` is `REVIEW_REQUIRED` or `CHANGES_REQUESTED`, else by a required check or a rule; `DRAFT` is blocked by the draft; `DIRTY` is conflicting; `BEHIND` is behind; `UNKNOWN` is pending"
const READY_MUTATION =
  "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }"

const ISSUE_FIELDS =
  "`<fields>` as `labels` (names; one the repo doesn't have fails the call, so leave it out and say so), `assignee` (a login: for a name or email, the one among `GET /repos/{owner}/{repo}/assignees` whose login or name matches), and `project` (a GitHub project's title: add the issue to it, `gh issue edit <N> --repo {owner}/{repo} --add-project <project>`, which needs the `project` token scope). `priority` only as a label, when the repo has labels for it (`P0` to `P3`, `priority: high`): one, replacing any other priority label. GitHub issues have no estimate, cycle, or due date: leave those out, and say so in the report when the flow set one"

const STATE =
  "`todo`, `in progress`, and `in review` → open, `done` → closed as completed, `canceled` → closed as not planned. Skip it when the issue is already there"

// `<N>` is the number in an issue id, which is written `#<N>`.
const ISSUE_NUMBER = "`<N>` is the number in `<ID>`"

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
    {
      key: "labels",
      type: "string[]",
      description:
        "Labels sync picks one of for each issue, by the kind of work, when GitHub tracks the repo's issues",
      example: ["bug", "enhancement", "documentation"],
    },
    {
      key: "project",
      description:
        "GitHub project new issues go in (its title), when GitHub tracks the repo's issues",
      example: "Roadmap",
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
      branchPr: {
        mcp: `The GitHub MCP's \`list_pull_requests\` for {owner}/{repo} with \`head: {owner}:<branch>\` and \`state: all\`, the most recent; then its pull request read tool for ${PR_FIELDS}`,
        cli: `\`gh pr list --repo {owner}/{repo} --head <branch> --state all --limit 1 --json ${PR_JSON}\`: an empty list means none`,
        api: `${API}/pulls?state=all&head={owner}:<branch>"\`, the most recent; then \`prMetadata\` for its counts`,
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
      prMergeState: {
        mcp: `The GitHub MCP's pull request read tool for {owner}/{repo} #<N>: its \`mergeable_state\`, upper-cased, reads as ${MERGE_STATE}`,
        cli: `\`gh pr view <N> --repo {owner}/{repo} --json mergeStateStatus,reviewDecision\`: ${MERGE_STATE}`,
        api: `${API}/pulls/<N>"\`: its \`mergeable_state\`, upper-cased, reads as ${MERGE_STATE}`,
      },
      // CLI and API first: they pin the head, which the MCP's merge can't.
      prMerge: {
        cli: "`gh pr merge <N> --repo {owner}/{repo} --<method> --match-head-commit <sha>`. Never with `--delete-branch` (its local cleanup fails in a worktree), `--admin`, or `--auto`",
        api: `\`PUT\` ${API_BARE}/pulls/<N>/merge\` (header \`Authorization: Bearer {token}\`) with JSON \`merge_method\` <method> and \`sha\` <sha>: 405 is refused, with the reason in \`message\`; 409 is a moved head`,
        mcp: "The GitHub MCP's `merge_pull_request` for {owner}/{repo} #<N> with `merge_method: <method>`. It can't pin the head, so read the pull request's `head.sha` with its read tool just before, and don't merge unless it's <sha>",
      },
      prClose: {
        mcp: "The GitHub MCP's `update_pull_request` for {owner}/{repo} #<N> with `state: closed`",
        cli: "`gh pr close <N> --repo {owner}/{repo}`. Never with `--delete-branch`, which deletes the local branch too",
        api: `\`PATCH\` ${API_BARE}/pulls/<N>\` (header \`Authorization: Bearer {token}\`) with JSON \`state\` \`closed\``,
      },
      prReady: {
        mcp: "The GitHub MCP's `update_pull_request` for {owner}/{repo} #<N> with `draft: false`",
        cli: "`gh pr ready <N> --repo {owner}/{repo}`",
        api: `${GRAPHQL} with JSON \`query\` \`${READY_MUTATION}\` and \`variables\` \`{"id": "<node_id>"}\`, \`<node_id>\` the pull request's \`node_id\` from ${API}/pulls/<N>"\``,
      },
      // Also an adapter (`adapters/github.ts`), run first: two paged lists,
      // check runs and commit statuses, read as one.
      checks: {
        cli: "`gh api --paginate 'repos/{owner}/{repo}/commits/<sha>/check-runs?per_page=100'` and `gh api --paginate 'repos/{owner}/{repo}/commits/<sha>/status?per_page=100'`. A check run is `pending` until its `status` is `completed`, then by `conclusion`: `success` or `neutral` pass, `skipped` is skipping, `cancelled` is cancelled, anything else fails; its `link` is `details_url`, and its `log` its `id` when `app.slug` is `github-actions`. A status (named by `context`) passes on `success`, is pending on `pending`, and fails otherwise, with `link` its `target_url` and no `log`. With <base>, a check is `required` when its name is in `gh api repos/{owner}/{repo}/branches/<base> --jq '.protection.required_status_checks.contexts[]?'` or in the `required_status_checks` rules of `gh api --paginate repos/{owner}/{repo}/rules/branches/<base>` (each rule's `parameters.required_status_checks[].context`)",
        api: `${API}/commits/<sha>/check-runs?per_page=100"\` and ${API}/commits/<sha>/status?per_page=100"\`, following the \`Link\` header's next pages, read as the CLI variant says (with <base>, \`required\` from ${API}/branches/<base>"\` and ${API}/rules/branches/<base>"\` as it says)`,
        mcp: "The GitHub MCP's check run and commit status tools for {owner}/{repo} at <sha>, read as the CLI variant says",
      },
      checkLog: {
        mcp: "The GitHub MCP's `get_job_logs` for {owner}/{repo} with `job_id: <log>` and `tail_lines: 200`",
        cli: "`gh run view --job <log> --log-failed --repo {owner}/{repo} | tail -200` (its failed steps; `--log` for all of it when that prints nothing)",
        api: `${API}/actions/jobs/<log>/logs" | tail -200\` (it redirects to the log, which \`-L\` follows)`,
      },
      reviewThreads: {
        cli: `\`gh api graphql -f query='${THREADS_QUERY}' -f owner={owner} -f repo={repo} -F n=<N>\` (add \`-f after=<endCursor>\` for the next page). ${THREADS}`,
        api: `${GRAPHQL} with JSON \`query\` \`${THREADS_QUERY}\` and \`variables\` \`{"owner": "{owner}", "repo": "{repo}", "n": <N>}\`. ${THREADS}`,
        mcp: "The GitHub MCP's pull request read tool (`pull_request_read` with `method: get_review_comments`) for {owner}/{repo} #<N>: the threads not resolved, each with its comments. An author is a bot when its login ends in `[bot]` or its type is `Bot`",
      },
      resolveThread: {
        cli: `\`gh api graphql -f query='${RESOLVE_MUTATION}' -f id=<id>\``,
        api: `${GRAPHQL} with JSON \`query\` \`${RESOLVE_MUTATION}\` and \`variables\` \`{"id": "<id>"}\``,
      },
    },
    // Opt-in (`optIn` below): most repos on GitHub track issues elsewhere.
    issueTracker: {
      issueRef:
        "`#<N>` or `{owner}/{repo}#<N>`, or a `https://github.com/{owner}/{repo}/issues/<N>` URL. A bare number isn't one, since it's as often a pull request, and with more than one GitHub entry tracking issues, `#<N>` alone names none of them. Write its id as `#<N>`",
      getIssue: {
        mcp: `The GitHub MCP's \`issue_read\` with \`method: get\` (or \`get_issue\`) for {owner}/{repo} #<N> (${ISSUE_NUMBER}): its title, URL, \`state\` and \`state_reason\` (closed as \`not_planned\` is canceled), body, labels, and assignees. It doesn't say the parent, project, or the pull requests that close it: get those from the CLI or API variant when it works here. A pull request's number is not an issue: there is none`,
        cli: `\`gh api graphql -f query='${ISSUE_QUERY}' -f owner={owner} -f repo={repo} -F n=<N>\` (${ISSUE_NUMBER}): a \`stateReason\` of \`NOT_PLANNED\` is canceled, and a pull request is attached when \`closedByPullRequestsReferences\` has one. ${ISSUE_NOT_FOUND}`,
        api: `${GRAPHQL} with JSON \`query\` \`${ISSUE_QUERY}\` and \`variables\` \`{"owner": "{owner}", "repo": "{repo}", "n": <N>}\` (${ISSUE_NUMBER}): a \`stateReason\` of \`NOT_PLANNED\` is canceled, and a pull request is attached when \`closedByPullRequestsReferences\` has one. ${ISSUE_NOT_FOUND}`,
      },
      findIssue: {
        mcp: `The GitHub MCP's \`search_issues\` with \`query: repo:{owner}/{repo} is:issue is:open "<branch>" in:body\`, every page. ${BRANCH_MATCH}`,
        cli: `\`gh issue list --repo {owner}/{repo} --state open --search '"<branch>" in:body' --limit 200 --json number,title,url,body,updatedAt\`. ${BRANCH_MATCH}`,
        api: `${SEARCH}<the query, URL-encoded>"\` with the query \`repo:{owner}/{repo} is:issue is:open "<branch>" in:body\`, following the \`Link\` header's next pages. ${BRANCH_MATCH}`,
      },
      searchIssues: {
        mcp: "The GitHub MCP's `search_issues` with `perPage: 10`: once with `query: repo:{owner}/{repo} is:issue is:open <text>`, and once with `is:closed closed:>=<the date 90 days ago>` in place of `is:open`. Load a candidate with `getIssue` for its parent and whether a pull request is attached. Then try two or three shorter queries from the text's key words, since search matches words, not meaning",
        cli: "`gh search issues <text> --repo {owner}/{repo} --match title,body --limit 10 --json number,title,url,state,body`: once with `--state open`, and once with `--state closed --closed '>=<the date 90 days ago, YYYY-MM-DD>'`. Load a candidate with `getIssue` for its parent and whether a pull request is attached. Then try two or three shorter queries from the text's key words, since search matches words, not meaning",
        api: `${SEARCH}<the query, URL-encoded>"\`, once with the query \`repo:{owner}/{repo} is:issue is:open <text>\` and once with \`is:closed closed:>=<the date 90 days ago>\` in place of \`is:open\`, the first 10 of each. Load a candidate with \`getIssue\` for its parent and whether a pull request is attached. Then try two or three shorter queries from the text's key words, since search matches words, not meaning`,
      },
      assignedIssues: {
        cli: `\`gh api graphql -f query='${ASSIGNED_QUERY}' -f q='repo:{owner}/{repo} is:issue is:open assignee:@me'\` (add \`-f after=<endCursor>\` for the next page), ${ASSIGNED}`,
        api: `${GRAPHQL} with JSON \`query\` \`${ASSIGNED_QUERY}\` and \`variables\` ${ASSIGNED}`,
      },
      createIssue: {
        mcp: `The GitHub MCP's \`issue_write\` with \`method: create\` (or \`create_issue\`) for {owner}/{repo} with \`title\`, \`body\` <description>, \`assignees\` the current user's login (\`get_me\`) unless \`<fields>\` names an assignee, and ${ISSUE_FIELDS}. With \`<parent>\`, then \`sub_issue_write\` with \`method: add\` (or \`add_sub_issue\`) on the parent's number, with \`sub_issue_id\` the new issue's \`id\` (not its number). Its id is \`#<number>\`. A new issue is open, which is every <state> but \`done\` and \`canceled\``,
        cli: `\`gh issue create --repo {owner}/{repo} --title <title> --body-file <a file holding the description> --assignee @me\` (the login instead, when \`<fields>\` names an assignee), with \`--label\` per label and ${ISSUE_FIELDS}. It prints the issue's URL, which ends in its number \`<N>\`. With \`<parent>\`, then \`gh api -X POST repos/{owner}/{repo}/issues/<the parent's number>/sub_issues -F sub_issue_id="$(gh api repos/{owner}/{repo}/issues/<N> -q .id)"\`. Its id is \`#<N>\``,
        api: `\`POST\` ${API_BARE}/issues\` (header \`Authorization: Bearer {token}\`) with JSON \`title\`, \`body\` <description>, \`assignees\` (the token's user from \`GET https://api.github.com/user\`, unless \`<fields>\` names an assignee), and ${ISSUE_FIELDS}; it returns \`number\`, \`html_url\`, and \`id\`. With \`<parent>\`, then \`POST\` ${API_BARE}/issues/<the parent's number>/sub_issues\` with JSON \`sub_issue_id\` the new issue's \`id\` (not its number). Its id is \`#<number>\``,
      },
      updateIssue: {
        mcp: `The GitHub MCP's \`issue_write\` with \`method: update\` (or \`update_issue\`) for {owner}/{repo} #<N> (${ISSUE_NUMBER}) with \`title\`, \`body\` <description>, \`state\` and \`state_reason\` for <state>: ${STATE}, and ${ISSUE_FIELDS}. Its \`labels\` and \`assignees\` replace the whole list, so pass the issue's current ones (\`getIssue\`) with only the change made. With <parent>, \`sub_issue_write\` with \`method: add\` on <parent>'s number, \`sub_issue_id\` this issue's \`id\`, and \`replace_parent: true\``,
        cli: `\`gh issue edit <N> --repo {owner}/{repo} --title <title> --body-file <a file holding the description>\` (${ISSUE_NUMBER}), with \`--add-label\` and \`--remove-label\` for a label change, \`--add-assignee\` for an assignee, and ${ISSUE_FIELDS}. Then for <state>: ${STATE}, with \`gh issue close <N> --repo {owner}/{repo} --reason completed\` (\`--reason "not planned"\` for canceled) or \`gh issue reopen <N> --repo {owner}/{repo}\`. With <parent>, \`gh api -X POST repos/{owner}/{repo}/issues/<parent's number>/sub_issues -F sub_issue_id="$(gh api repos/{owner}/{repo}/issues/<N> -q .id)" -F replace_parent=true\``,
        api: `\`PATCH\` ${API_BARE}/issues/<N>\` (header \`Authorization: Bearer {token}\`; ${ISSUE_NUMBER}) with JSON \`title\`, \`body\` <description>, \`state\` (\`open\` or \`closed\`) and \`state_reason\` (\`completed\`, \`not_planned\`, or \`reopened\`) for <state>: ${STATE}, \`assignees\`, and ${ISSUE_FIELDS}. For a label change, \`POST .../issues/<N>/labels\` with JSON \`labels\` to add and \`DELETE .../issues/<N>/labels/<name>\` to remove, never \`labels\` in the \`PATCH\`, which replaces every label the issue has. With <parent>, \`POST\` ${API_BARE}/issues/<parent's number>/sub_issues\` with JSON \`sub_issue_id\` this issue's \`id\` and \`replace_parent: true\``,
      },
      projectIssues: {
        cli: "`gh project list --owner {owner} --format json` for the number of the project whose `title` is <project>, then `gh project item-list <number> --owner {owner} --format json --limit 1000`, keeping the items whose `content.type` is `Issue`, whose `content.repository` is `{owner}/{repo}`, and that are open (load each with `getIssue` for its state, priority, due date, and parent when the item doesn't carry them). Reading projects needs the `read:project` token scope; when it fails, say so",
        api: `${GRAPHQL} \`repositoryOwner(login: "{owner}") { ... on ProjectV2Owner { projectsV2(first: 20, query: "<project>") { nodes { title items(first: 100, after: <cursor>) { pageInfo { hasNextPage endCursor } nodes { content { ... on Issue { number title url state repository { nameWithOwner } labels(first: 20) { nodes { name } } milestone { dueOn } parent { number } } } } } } } } }\`, the project whose \`title\` is <project>, following \`endCursor\`, keeping open issues of {owner}/{repo}: priority from a priority label, due date from the milestone's \`dueOn\`. Needs the \`read:project\` scope`,
      },
      fieldOptions: {
        cli: "`gh api --paginate repos/{owner}/{repo}/assignees --jq '.[].login'` for the people (each login as `name`), `gh label list --repo {owner}/{repo} --limit 1000 --json name` for the labels, and `gh project list --owner {owner} --format json` for the projects (their `title`s; leave them out when it fails for want of the `read:project` scope). GitHub has no cycles: leave them out",
        api: `${API}/assignees?per_page=100"\` for the people (each \`login\` as \`name\`), ${API}/labels?per_page=100"\` for the labels, following the \`Link\` header's next pages; projects as the CLI variant says, through ${GRAPHQL} \`repositoryOwner(login: "{owner}") { ... on ProjectV2Owner { projectsV2(first: 100) { nodes { title } } } }\`. No cycles`,
      },
      recordNotes: {
        unsupported: "GitHub has no cycles, so no planning document for one",
      },
      // GitHub's issue dependencies; the MCP has no tool for them.
      linkBlocked: {
        cli: `\`gh api -X POST repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by -F issue_id="$(gh api repos/{owner}/{repo}/issues/<the blocker's number> -q .id)"\` (${ISSUE_NUMBER}), unless \`gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by -q '.[].number'\` already lists the blocker`,
        api: `\`POST\` ${API_BARE}/issues/<N>/dependencies/blocked_by\` (header \`Authorization: Bearer {token}\`; ${ISSUE_NUMBER}) with JSON \`issue_id\` the blocker's \`id\` (from ${API}/issues/<the blocker's number>"\`, not its number), unless ${API}/issues/<N>/dependencies/blocked_by"\` already lists the blocker`,
      },
      prLink:
        "Closing: a `Fixes #<N>` line in the pull request body, which closes the issue when the pull request merges into the default branch (merging into another base closes nothing). Linking only: a `Part of #<N>` line, which only cross-references it. Either way the title can stay as the repo writes it",
    },
  },
  optIn: ["issueTracker"],
  adapters: { checks },
  detect(ctx) {
    const remote = ctx.git(["remote", "get-url", "origin"])
    const parsed = remote ? parseGithubRemote(remote) : undefined
    return parsed
      ? { values: parsed, evidence: [`origin remote ${remote}`] }
      : undefined
  },
}

import type { Flow } from "@agent-flows/core"
import { ISSUE_FIELD_RULES } from "./issues.ts"
import {
  DEV_COMMANDS,
  devKit,
  REQUIRE_CONFIG,
  USE_INTEGRATIONS,
} from "./kit.ts"

// The PR body sync writes inside its block; everything outside it is the
// team's and survives every re-run.
const PR_BLOCK = `> Issue: [<ID>: <issue title>](<issue URL>)   (one line per linked issue; omit with no issue tracker)
> Errors: <short id> ([<title>](<URL>))   (one line per error ref; omit when there are none)
> <session-sharing name>: [Session](<session URL>)   (omit with no session link)

<the issue tracker's prLink form, when it goes in the body: \`Fixes <ID>\` or \`Part of <ID>\`>

## Summary

- <what this change does and why, 1-3 bullets>

<before and after, when the change alters behavior that already existed>

## Test plan

- [ ] <how to verify the change works>
- [ ] <an edge case worth checking>

<lastSyncedLine>`

const ISSUE_DESCRIPTION = `> Branch: \`<branch>\`
> Errors: <short id> ([<title>](<URL>))   (one line per error ref; omit when there are none)
> <session-sharing name>: [Session](<session URL>)   (omit with no session link)

## Description

<the stable "what" of the work, 1-3 sentences. Written once, never rewritten by sync>

## Status

**Done:**

- <finished items>

**Remaining:**

- <what's left>

<lastSyncedLine>`

export const syncFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "sync",
  title: "{{cmd}}sync",
  frontmatter: {
    description:
      "Commit, catch up to the base branch, push, and keep the draft PR and its issue in step with the branch. Only for the named agent-flows sync workflow, not generic commit or push requests.",
    argumentHint: { deriveFromModes: true, suffix: "[ISSUE-ID]" },
  },
  commands: DEV_COMMANDS.defineCommands({
    configure: {
      description:
        "`get <path>...` prints configured values; `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Both exit 2 when the repo isn't configured for what's asked",
      args: "<subcommand>",
    },
    sync: {
      description:
        "`survey` reads git state and computes the no-op gate; `facts` prints the issue state and last-synced line for the remote writes; `splice` merges sync's block into a PR body; `finish` records the sync. State lives in the repo's git common dir, per branch",
      args: "<subcommand>",
    },
  }),
  tools: {},
  compile: {
    // The survey decides which phases run, so a no-op never loads the local
    // or remote prose, and a local-only sync never loads the remote prose.
    mode: { default: "split-chain" },
    inlinePhases: ["main"],
  },
  entries: {
    default: "main/survey",
    local: "main/survey",
    remote: "main/survey",
    help: "main/help",
  },
  defaultMode: "default",
  modeHints: {
    default:
      "Commit, catch up to the base branch, push, and create or refresh the draft PR and its issue.",
    local:
      "Local only: commit and catch up to the base branch. No push, PR, or issue.",
    remote:
      "Remote only: refresh the PR and its issue. No commits, catch-up, or push; never creates a PR.",
    help: "Show usage and exit without syncing.",
  },
  intro:
    "Keeps the branch, its draft pull request, and its issue in step with the work. Safe to re-run: the survey compares everything a sync consumes against the last sync and skips the phases whose inputs didn't change. Every vendor-specific action goes through the repo's configured integrations (`{{cmd}}configure`), so the same skill works with any source-control host, stacking tool, issue tracker, or error tracker, or none of the optional ones.",
  invariants: [
    "**Act through the integrations' ops.** Pull requests, stacks, issues, and error issues are reached only through the ops `configure.ts integrations` returns, run as given. Plain `git` is fine for everything local.",
    "**Never change a pull request's draft or ready state.** Sync opens pull requests as drafts and leaves an existing one's state alone; marking it ready is the author's call.",
    "**Never rewrite pushed history yourself.** Without a stacking integration, catch up with `git merge`, never `git rebase`, so a push never needs force. With one, its `restack` and `submit` ops own the rebase and the push.",
    "**Never use destructive escapes** (`git reset --hard`, `git rebase --abort`, `git stash`, `git push --force` without `--force-with-lease`) to get out of a conflict.",
    "**Stage everything** with `git add -A` for a commit; for conflict resolution, stage each file with `git add <file>`, never `-A`.",
    "**Don't prompt** for anything inferable from the branch, commits, diff, session, or config.",
    "**Write only what sync owns.** In the PR body that's its block; in the issue description, the branch, error, and session lines, `## Status`, and the last-synced line; on the issue, the fields under Issue fields, within their rules. A section a person wrote stays as they wrote it.",
  ],
  phases: [
    {
      id: "main",
      title: "Main",
      stepStyle: "headers",
      steps: [
        {
          id: "help",
          kind: "action",
          title: "Help shortcut",
          preamble: true,
          body: `If mode is \`help\`, print the block below verbatim and exit. No reads, no writes.

> \`{{cmd}}sync\` keeps the branch, its draft PR, and its issue in step with the work on this branch. Safe to re-run.
>
> Modes:
>   - (no arg) -- default: commit, catch up to the base branch, push, and create or refresh the draft PR and its issue
>   - \`local\` -- local only: commit and catch up to the base branch. No push, PR, or issue.
>   - \`remote\` -- remote only: refresh the PR and its issue. No commits, catch-up, or push; never creates a PR.
>   - \`help\` -- show this and exit
>
> Pass an issue id (\`{{cmd}}sync ENG-123\`) to link the branch to that issue.
>
> A re-run with nothing changed since the last sync (no new commits, clean tree, base not advanced, PR state unchanged) stops at the no-op gate.
>
> It uses the integrations in \`.agent-flows/config.json\`: source control for the PR (required outside \`local\` mode), and, when configured, stacking for restack and push, an issue tracker for the issue, error tracking to link and resolve the errors the work fixes, and session sharing to link the session behind the work. Set them up with \`{{cmd}}configure\`.
>
> Before filing an issue, it searches open and recently closed ones for the same work (with \`{{cmd}}create-tickets match\`), and reuses a match or files a sub-issue under a larger one. The PR's Summary and Test plan and the issue's Status are regenerated each sync. The issue's Description is written once; the issue's state follows the PR (todo, in progress, in review, done, canceled). Its priority is set once and then left to people; its labels, estimate, cycle, and project follow the config and the repo's agent instructions.`,
          next: null,
        },
        {
          id: "survey",
          kind: "action",
          title: "Survey",
          refName: "survey",
          commandCalls: ["configure", "sync"],
          body: `Parse the argument for a mode keyword (\`local\`, \`remote\`, \`help\`) and an optional issue id. No keyword means default mode.

| Mode | Survey | Local git work | Remote writes |
|------|--------|-------|--------|
| default | Full | When \`runLocal\` | When \`runRemote\` |
| \`local\` | Skip 1a | When \`runLocal\`, never pushes | Never |
| \`remote\` | Full | Never | When \`runRemote\`, never creates a PR |

The issue tracks the work (a stable Description plus a regenerated Status); the PR describes the change (a regenerated Summary and Test plan). Don't put Status in the PR or the Test plan in the issue.

1. **Base branch:** \`{{command:configure}} get repo.baseBranch\` prints \`{"values": {"repo.baseBranch": "<base>"}}\`. ${REQUIRE_CONFIG}
2. **Integrations:** \`{{command:configure}} integrations sourceControl stacking issueTracker errorTracking sessions --optional\` prints every entry the repo configured for each. ${USE_INTEGRATIONS}
   - **Source control:** keep the entry whose repository (from its \`values\`) is this checkout's \`origin\` in \`git remote -v\`. Outside \`local\` mode, with none, stop: \`No configured source-control repository is this checkout's origin. Run {{cmd}}configure sourceControl, then re-run.\` With one at \`level\` \`read\`, stop too: \`The team uses <entry> read-only, so sync can't push or edit its pull requests. Run {{cmd}}configure <integration> to change that, or use {{cmd}}sync local.\`
   - **Stacking:** use the first entry, if any. With none, the branch is a plain branch off the base.
   - **Issue tracker:** look issues up in every entry. Only entries at \`level\` \`track\` get issues filed or updated: file a new one in the first of those, unless the user or the repo's agent instructions name another. At \`link\`, an existing issue is only linked from the PR. With none, skip everything about issues.
   - **Error tracking:** every entry, if any. Only entries at \`level\` \`resolve\` resolve errors on merge; at \`link\`, errors are only linked.
   - **Session sharing:** the first entry, if any. With none, nothing is shared.
3. **Pull request:** outside \`local\` mode, run the source-control entry's \`currentPr\` op. \`<pr>\` is \`<number>:<open|merged|closed>:<true|false>\` (the last part is whether it's a draft), or \`none\`. A merged or closed PR still counts: its state is what the issue follows. In \`local\` mode \`<pr>\` is \`none\`.
4. **Error refs:** outside \`local\` mode, scan the triggering message, this session, and the PR body's \`> \` link lines (an earlier sync tool may have written its own, named for the error tracker) for strings any error-tracking entry's \`issueRef\` op says name one of its issues. The conversation is the one input no fingerprint sees, so pass each as \`--error-ref <ref>\` (a short id, or the URL).
5. **Survey:** \`{{command:sync}} survey <mode> --base <base> --pr <pr> [--error-ref <ref>]...\` fetches the base (except in \`remote\` mode) and prints JSON: \`branch\`, \`baseRef\` (the ref to compare against), \`onBase\`, \`dirty\`, \`ahead\`, \`behind\`, \`unpushed\`, \`head\`, \`pr\`, \`issue\` (cached for this branch, or left for it by an earlier sync tool's state in the worktree), \`errorRefs\` (every ref this branch has collected), \`newErrorRefs\` (not yet linked), \`lastSyncedHead\`, \`format\` (how sync writes this branch's lines and title: the config's \`sync\` section, then the format the branch was last written in; see 3c), and the gate: \`runLocal\`, \`runRemote\`, \`noop\`. If it fails because HEAD is detached, stop and tell the user to check out a branch.

### Routing

These signals are the authority and **override the \`**Next:**\` block below**, which lists only each mode's next phase. Apply them first:

- \`noop: true\`: nothing this mode consumes changed since the last sync. Skip 1a and go straight to {{dispatch-ref:report}}.
- \`runLocal: false\`: no commit, catch-up, or push to do. In default mode go to {{dispatch-ref:remote}}; in \`local\` mode go to {{dispatch-ref:report}}.
- \`runRemote: false\` (in \`remote\` mode): the PR and issue already reflect this HEAD. Go to {{dispatch-ref:report}}.
- Otherwise follow \`**Next:**\`.

### 1a. Find the issue

**Skip in \`local\` mode, with no issue tracker, or when \`runRemote\` is false and \`onBase\` is false** (nothing to write and no branch to name). A ref below means a string an issue-tracker entry's \`issueRef\` op matches; load each candidate with that entry's \`getIssue\` op, and fall through when it's missing or archived. Stop at the first match:

1. A ref in the argument, or in the triggering message.
2. The survey's \`issue\`: cached for this branch by an earlier sync. Load it with \`getIssue\`: someone may have closed it since. Canceled, or done while this branch's PR isn't merged, means the team dropped it: forget it (\`finish --issue none\` in the report) and keep looking, skipping that issue below.
3. A ref in the branch name.
4. A ref at the start of the PR title.
5. The PR body's \`> Issue:\` line, or the issue link an earlier sync tool put at the top of the body (a \`> \` line named for the tracker, linking \`<ID>: <title>\`).
6. Each entry's \`findIssue\` op with \`<branch>\` this branch: it finds the \`> Branch:\` anchor line sync writes into every issue it files or refreshes, and the bare one earlier sync tools wrote. Several matches is an anomaly: take the most recently updated one, and say so in the report.
7. A ref in recent user messages that is clearly about this work, not a passing mention.
8. **The same work, filed by someone else.** Only with an entry at \`track\`, which is where a new issue would go. Many issues for a branch's work were filed from planning notes (by \`{{cmd}}create-tickets\`, say), by someone else, or long ago, and carry no \`> Branch:\` line. Draft the new issue first: a 5-10 word title and a 1-3 sentence description of the work, from the PR title and body, then the session, then the commits (if all three are empty, ask: "What are you working on?"). Then run the \`{{cmd}}create-tickets\` skill with \`match --branch <branch> <title>. <description>\`: it searches every issue-tracker entry the way create-tickets does before filing, judges each candidate against this branch's work, and files and changes nothing. Its line for the item decides:
   - **\`match <ID>\`:** the same work, open, with no pull request attached: that's this branch's issue. 3d adds the \`> Branch:\` line, so the next sync finds it directly.
   - **\`sub-issue of <ID>\`:** part of a larger open issue, or the same work under another pull request: plan a new issue as a sub-issue of it (\`<parent>\`), so each pull request has its own issue.
   - **\`new\`:** plan a new issue from the draft.

   Name each \`closed:\` issue it lists in the report (never this branch's issue: its work is finished), and each \`also tracked:\` one. On \`search skipped\`, plan a new issue and say in the report that the search was skipped.

Nothing found, and an entry at \`track\`: the new issue planned in 8 is filed by the remote writes. With entries only at \`link\`, there's no issue; carry on without one. File it whatever the change is, a small or internal one included; an issue for every branch is the lockstep this command keeps.`,
          next: {
            byMode: {
              default: "local/local-git",
              local: "local/local-git",
              remote: "remote/remote-writes",
              help: null,
            },
          },
        },
      ],
    },
    {
      id: "local",
      title: "Local sync",
      stepStyle: "headers",
      steps: [
        {
          id: "local-git",
          kind: "action",
          title: "Local git work",
          refName: "local git work",
          body: `**Skip when the survey said \`runLocal: false\`**: in default mode go straight to {{dispatch-ref:remote}}; in \`local\` mode go straight to {{dispatch-ref:report}}.

\`<base>\`, \`<baseRef>\`, and the integration entries are from the survey.

### 2a. Branch

Only when \`onBase\` is true. Create the branch before anything else, and don't stage anything first: \`git switch -c <name>\`, where \`<name>\` is the issue id in lowercase (when 1a found or planned one with an id) and a 3-5 word slug of the work, joined by \`-\`. Follow the naming the repo's recent branches use (\`git branch -r --sort=-committerdate | head -20\`), such as a personal prefix. On a feature branch, keep it: never rename a branch that has a PR.

### 2b. Track the stack

With a stacking integration: run its \`parent\` op. If it fails, the branch isn't tracked; run its \`track\` op with \`<parent>\` set to the PR's base branch when there's a PR, else \`<base>\`.

### 2c. Commit

When \`git status --porcelain\` isn't empty: \`git add -A\`, then \`git commit -m "<message>"\`. Write the message in the repo's convention: its agent instructions first, then the shape of recent subjects (\`git log -20 --format=%s\`). If the commit fails (a hook rejected it), read the error, fix the cause, and commit again; don't skip hooks.

### 2d. Catch up

- **With a stacking integration:** run its \`restack\` op.
- **Without one:** when \`git rev-list --count HEAD..<baseRef>\` isn't 0, \`git merge --no-edit <baseRef>\`.

On conflicts, run \`git status\`, read each conflicted file, and write a resolution that keeps the intent of both sides. Resolve routine collisions yourself (imports, lockfiles, settings, formatting, counts both sides moved); **stop and ask** only when both sides changed the same logic incompatibly. Stage each file with \`git add <file>\`, then finish: the stacking integration's \`continue\` op after a restack (repeat until the restack completes), \`git commit --no-edit\` after a merge.

### 2e. Push

**Default mode only**, and only when \`git rev-list --count <baseRef>..HEAD\` isn't 0.

- **With a stacking integration:** its \`submit\` op.
- **Without one:** \`git push -u origin HEAD\`. If it's rejected because the remote branch moved, \`git fetch origin <branch>\`, \`git merge --no-edit origin/<branch>\`, resolve as above, and push again. Never force.

\`local\` mode never pushes.

### 2f. Mergeability

**Default mode only, when a PR exists** (re-run \`currentPr\`: the push may have opened one). Run the source-control entry's \`prMergeability\` op:

- \`clean\`: continue.
- \`pending\`: the host is still computing it. \`sleep 3\` and ask again, up to 3 times; then treat it as \`clean\`.
- \`conflicting\` or \`behind\`: take one more pass: fetch, run 2d and 2e again, and ask again. Still \`conflicting\` or \`behind\`: stop and show the user what the op returned. With a stack, a parent that hasn't merged or restacked is the usual cause. Don't loop.`,
          next: {
            byMode: {
              default: "remote/remote-writes",
              local: "report/report",
              remote: null,
              help: null,
            },
          },
        },
      ],
    },
    {
      id: "remote",
      title: "Remote sync",
      stepStyle: "headers",
      steps: [
        {
          id: "remote-writes",
          kind: "action",
          title: "Remote writes",
          refName: "remote writes",
          body: `**Skip when the survey said \`runRemote: false\`**, and go straight to {{dispatch-ref:report}}. In default mode local work always sets it, since it moves HEAD.

Order matters: the session link exists before the PR and issue carry it (3a first), the issue exists before the PR body links it (3b before 3c), and the issue's state follows the PR (3d after 3c).

Re-run the source-control entry's \`currentPr\` op for a fresh \`<pr>\` (local work may have opened one), then:

\`\`\`bash
{{command:sync}} facts --base <base> --pr <pr>
\`\`\`

It prints \`workState\` (the issue's state, from the PR and the branch: \`todo\` with nothing ahead of the base, \`in progress\` with a draft or no PR, \`in review\` when ready, \`done\` when merged, \`canceled\` when closed), \`lastSyncedLine\` (the marker that ends the PR block and the issue's Status, used verbatim), and \`updateKind\`. Use them as given; don't derive the state yourself.

- **\`updateKind: full\`:** run 3a-3e. Its \`commits\` and \`diffStat\` are the main inputs for the prose, with the session; read the full diff only when you can't write an accurate summary without it.
- **\`updateKind: metadata-only\`:** HEAD hasn't moved since the last remote sync; only the PR's state or the error refs did. Skip 3a (there's no new work to share), and don't regenerate the Summary, Test plan, or Status: in 3c and 3d, update only the \`> \` link lines, the issue's state, and the last-synced line, and leave the issue fields alone. Then 3e.

Files go in the worktree's private git dir, \`<dir>\` from \`git rev-parse --absolute-git-dir\` plus \`/agent-flows\`, so they never land in the tree.

### 3a. Session

With a session-sharing entry: run its \`shareSession\` op and note the URL, for the session lines in 3c and 3d. Sharing the same session again updates its link, so a re-run doesn't pile up copies. When it fails (not signed in, the tool missing, a network error), say so in the report and carry on: sharing is never worth stopping a sync for, and the lines below keep the link from an earlier sync.

### 3b. Issue

With an issue tracker and a new issue planned in 1a: file it with that entry's \`createIssue\` op, using the description template in 3d, \`<parent>\` when 1a planned it as a sub-issue, and \`<fields>\` from the issue fields below. Note its id: \`finish\` caches it for the next sync.

#### Issue fields

For an entry at \`track\`, on filing and on every full update; the same rules \`{{cmd}}create-tickets\` files by. Take each field from, in order: the user or this session, the repo's agent instructions (\`AGENTS.md\`, \`CLAUDE.md\`, and the docs they point to for ranking or filing work), then the entry's \`values\` of the same name. With none of those, leave the field out. Pass as \`<fields>\` only the fields that change.

${ISSUE_FIELD_RULES}

### 3c. Pull request

Sync owns one block of the PR body:

\`\`\`markdown
${PR_BLOCK}
\`\`\`

- **Links:** a \`> Issue:\` line for the issue, an \`> Errors:\` line for each of the survey's \`errorRefs\`, and a session line, named for the session-sharing entry (its \`name\`), with the URL 3a shared. When 3a didn't share one, keep the session line the body already has, from this block or one an earlier sync tool wrote. When the tracker's \`prLink\` op puts its link in the body, add that line too: the closing form for an entry at \`track\` (merging closes the issue even if sync doesn't run again), the linking-only form at \`link\`, which never changes the issue.
- **The survey's \`format\`:** with \`linkLabels\` \`integration\`, label the issue and error lines with the \`name\` of the entry each links to (\`> <tracker name>:\` in place of \`> Issue:\`), in this block and in 3d. With an \`errorVerb\`, each error line starts with it (\`> Errors: <errorVerb> <short id> ([<title>](<URL>))\`). \`blockMarkers\` is \`splice\`'s to apply; write the block the same either way.
- **The repo's PR template:** when the repo has one (\`.github/pull_request_template.md\`, \`.github/PULL_REQUEST_TEMPLATE.md\`, or \`docs/\` or the root with either name), the block follows it instead of the Summary and Test plan headings: the template's sections in its order, filled in from the change. A "what and why" or summary section gets the Summary's content, a test section the Test plan's, and a checklist keeps its items, checked only for what's true and verified, with a short note where an item doesn't apply. Drop the template's HTML comments. The link lines stay on top and the last-synced line at the end.
- **Summary:** regenerated every sync, 1-3 bullets on what the change does and why. Don't restate the issue (the link does) or add progress (that's the issue's Status).
- **Before and after:** when the change alters behavior that already existed (a fix, or anything that changes what a person sees), add a bolded **Before** (what a person saw happen: the input, the result, whether anything was raised) and a bolded **After**. One or two changes get a short paragraph each; three or more get a table with Before and After columns, one row per change. Say which paths are unchanged. Skip it for a change that only adds something new.
- **Test plan:** regenerated every sync, 2-5 checkboxes from what changed. A single bullet is fine for a tiny change.

Write the current PR body (from \`currentPr\`; empty when there's no PR) to \`<dir>/pr-body.md\` and the new block to \`<dir>/pr-block.md\`, then:

\`\`\`bash
{{command:sync}} splice --body <dir>/pr-body.md --block <dir>/pr-block.md [--no-markers] > <dir>/pr-new.md
\`\`\`

It replaces the old block, or puts the block on top of a body that has none, and keeps everything else. A body an earlier sync tool wrote without the block's markers (link lines on top, a Summary and Test plan, a last-synced line) has those replaced too, so it doesn't end up with two of each. Pass \`--no-markers\` when the survey's \`format.blockMarkers\` is false: it writes the block without markers, the way that tool does, so the two can take turns on one PR.

With \`format.prTitle\` and an issue, the title is that template, with \`{issueId}\` and \`{title}\` the issue's id and title. Otherwise it follows the repo's convention: its agent instructions first, then the shape of recent subjects on the base (\`git log -20 --format=%s <baseRef>\`, which are PR titles when the repo squash-merges). Put the issue id in it only when the tracker's \`prLink\` op says the title is the only place that links them, keeping the rest of the convention. Keep the existing title when it still fits (with a template, only when it matches it). Quote the title for the shell: single quotes, with any \`'\` written as \`'\\''\`.

- **PR exists:** when the body or title changed, the \`prEdit\` op with \`<body-file>\` \`<dir>/pr-new.md\`.
- **No PR, default mode:** the \`prCreate\` op, with \`<base>\` the stacking integration's \`parent\` when stacked, else \`<base>\`.
- **No PR, \`remote\` mode:** skip. Remote mode never creates a PR.

### 3d. Issue

With an issue in an entry at \`track\` (at \`link\`, leave the issue alone; the PR's link is all): build its description from this template:

\`\`\`markdown
${ISSUE_DESCRIPTION}
\`\`\`

- **\`> Branch:\` line:** always, exactly as shown (the backticks keep the tracker from turning an id in the branch name into a link), in place of a bare \`> Branch:\` line an earlier sync tool wrote. It's the anchor 1a's \`findIssue\` looks for.
- **Error lines:** as in the PR block, labeled and worded by the survey's \`format\`.
- **Session line:** as in the PR block: the URL 3a shared, else the session line the description already has.
- **Other \`> \` lines** sync doesn't write (a planning link, say): keep them, below sync's.
- **Description:** keep the existing one. Write it only when the issue has none (a new issue, or one filed without it).
- **Status:** regenerated every sync, 3-8 plain bullets (no checkboxes) across Done and Remaining, about the implementation only, never review, merge, or deploy. When the implementation is complete, Remaining is \`None. Implementation complete; the rest is tracked on the PR.\`
- Keep any other section a person wrote.

Then the entry's \`updateIssue\` op with the title (keep the existing one unless a new one fits strictly better), the description, \`<state>\` \`workState\`, and \`<fields>\` from the issue fields in 3b.

### 3e. Errors

When \`workState\` is \`done\` (the PR merged): resolve each of the survey's \`errorRefs\` with the \`resolveIssue\` op of the error-tracking entry whose \`issueRef\` matches it, when that entry is at \`resolve\`. At \`link\`, leave it for the team, and list it in the report. Resolving is idempotent. Use the op's first variant that works here: an entry reached through its MCP server needs neither the CLI nor a token. A ref no entry matches, a call that fails, or one no variant can reach goes in the report as \`Needs manual resolve: <ref>\`, with what would make it work.`,
          next: "report/report",
        },
      ],
    },
    {
      id: "report",
      title: "Report",
      stepStyle: "headers",
      steps: [
        {
          id: "report",
          kind: "action",
          title: "Report",
          refName: "report",
          body: `First, on every path (the no-op gate included), record the sync so the next one can skip what's unchanged:

\`\`\`bash
{{command:sync}} finish --base <base> --pr <pr> [--remote] [--issue <id>] [--linked-ref <ref>]...
\`\`\`

- \`<pr>\`: the latest from \`currentPr\` (\`none\` in \`local\` mode).
- \`--remote\`: in default and \`remote\` mode, when the remote writes updated the PR and issue, or the gate said they were already current. Never in \`local\` mode, and not when the remote writes stopped partway.
- \`--issue\`: the issue's id, when there is one; \`none\` when 1a dropped a cached issue the team closed.
- \`--linked-ref\`: each error ref now in the PR's error lines.

**If this run hit the no-op gate**, print only \`Already synced: nothing changed since <short lastSyncedHead>.\` with the PR and issue URLs, then stop.

Otherwise lead with anything that needs the user's attention (an unresolved conflict, a mergeability problem, a failed write, an ambiguous issue match, a skipped issue search, a failed session share, errors to resolve by hand), then print:

- **Mode** that ran, and what was skipped and why (the local git work in \`remote\` mode or on \`runLocal: false\`; 1a and the remote writes in \`local\` mode or on \`runRemote: false\`).
- **Branch:** existing or created; what was committed; whether it caught up to the base (and any conflicts resolved, by file: a resolution nobody sees is one nobody checked); whether it was pushed.
- **PR:** URL, draft or ready, existing or created, and its mergeability.
- **Issue:** id, URL, and state; existing, found by the search (and which issue matched), created, or created as a sub-issue (of which); or none, with no issue tracker configured. The fields set or changed (priority, labels, estimate, cycle, project), and a closed issue the search found for the same work.
- **Session:** the shared URL, or skipped or failed, and why.
- **Errors:** refs linked, and any resolved.`,
          next: null,
        },
      ],
    },
  ],
})

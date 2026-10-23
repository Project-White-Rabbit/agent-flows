---
description: Commit, catch up to the base branch, push, and keep the draft PR and its issue in step with the branch. Only for the named agent-flows sync workflow, not generic commit or push requests.
argument-hint: "[local|remote|help] [ISSUE-ID]"
---

# /agent-flows:sync

Keeps the branch, its draft pull request, and its issue in step with the work. Safe to re-run: the survey compares everything a sync consumes against the last sync and skips the phases whose inputs didn't change. Every vendor-specific action goes through the repo's configured integrations (`/agent-flows:configure`), so the same skill works with any source-control host, stacking tool, issue tracker, or error tracker, or none of the optional ones.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `configure.ts <subcommand>` | `get <path>...` prints configured values; `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Both exit 2 when the repo isn't configured for what's asked |
| `sync.ts <subcommand>` | `survey` reads git state and computes the no-op gate; `facts` prints the issue state and last-synced line for the remote writes; `splice` merges sync's block into a PR body; `finish` records the sync. State lives in the worktree's git dir |

## Invariants

- **Act through the integrations' ops.** Pull requests, stacks, issues, and error issues are reached only through the ops `configure.ts integrations` returns, run as given. Plain `git` is fine for everything local.
- **Never change a pull request's draft or ready state.** Sync opens pull requests as drafts and leaves an existing one's state alone; marking it ready is the author's call.
- **Never rewrite pushed history yourself.** Without a stacking integration, catch up with `git merge`, never `git rebase`, so a push never needs force. With one, its `restack` and `submit` ops own the rebase and the push.
- **Never use destructive escapes** (`git reset --hard`, `git rebase --abort`, `git stash`, `git push --force` without `--force-with-lease`) to get out of a conflict.
- **Stage everything** with `git add -A` for a commit; for conflict resolution, stage each file with `git add <file>`, never `-A`.
- **Don't prompt** for anything inferable from the branch, commits, diff, session, or config.
- **Write only what sync owns.** In the PR body that's its block; in the issue description, the branch and error lines, `## Status`, and the last-synced line. A section a person wrote stays as they wrote it.

## Modes

Read `$ARGUMENTS` first. If its first token is exactly one of the mode names below, run that mode. Otherwise, when this skill documents how to route the remaining arguments (see its intro), follow that; if it doesn't, run `default` and treat `$ARGUMENTS` as its input. Follow only the selected mode's path below.

| Mode | Trigger | What it does |
|------|---------|--------------|
| `default` | (no argument) | Commit, catch up to the base branch, push, and create or refresh the draft PR and its issue. |
| `local` | `local` | Local only: commit and catch up to the base branch. No push, PR, or issue. |
| `remote` | `remote` | Remote only: refresh the PR and its issue. No commits, catch-up, or push; never creates a PR. |
| `help` | `help` | Show usage and exit without syncing. |

## 0. Help shortcut

**Run only when mode is `help`.**

If mode is `help`, print the block below verbatim and exit. No reads, no writes.

> `/agent-flows:sync` keeps the branch, its draft PR, and its issue in step with the work on this branch. Safe to re-run.
>
> Modes:
>   - (no arg) -- default: commit, catch up to the base branch, push, and create or refresh the draft PR and its issue
>   - `local` -- local only: commit and catch up to the base branch. No push, PR, or issue.
>   - `remote` -- remote only: refresh the PR and its issue. No commits, catch-up, or push; never creates a PR.
>   - `help` -- show this and exit
>
> Pass an issue id (`/agent-flows:sync ENG-123`) to link the branch to that issue.
>
> A re-run with nothing changed since the last sync (no new commits, clean tree, base not advanced, PR state unchanged) stops at the no-op gate.
>
> It uses the integrations in `.agent-flows/config.json`: source control for the PR (required outside `local` mode), and, when configured, stacking for restack and push, an issue tracker for the issue, and error tracking to link and resolve the errors the work fixes. Set them up with `/agent-flows:configure`.
>
> The PR's Summary and Test plan and the issue's Status are regenerated each sync. The issue's Description is written once; the issue's state follows the PR (todo, in progress, in review, done, canceled).

## 1. Survey

**Run only when mode is `default`, `local` or `remote`.**

Parse the argument for a mode keyword (`local`, `remote`, `help`) and an optional issue id. No keyword means default mode.

| Mode | Survey | Local git work | Remote writes |
|------|--------|-------|--------|
| default | Full | When `runLocal` | When `runRemote` |
| `local` | Skip 1a | When `runLocal`, never pushes | Never |
| `remote` | Full | Never | When `runRemote`, never creates a PR |

The issue tracks the work (a stable Description plus a regenerated Status); the PR describes the change (a regenerated Summary and Test plan). Don't put Status in the PR or the Test plan in the issue.

1. **Base branch:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" get repo.baseBranch` prints `{"values": {"repo.baseBranch": "<base>"}}`. If it exits with status 2 and prints `"configured": false`, stop this command here. Relay its `message`: the repo isn't set up for agent-flows yet, its config is invalid (`issues`), or it doesn't set what this command needs (`missing`: config paths, or capabilities with no integration). Tell the user to run `/agent-flows:configure` (naming the missing sections or capabilities, if any) and then re-run this command. Don't guess the values instead.
2. **Integrations:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations sourceControl stacking issueTracker errorTracking --optional` prints every entry the repo configured for each. Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `mcp` when you have tools from the MCP server `access.mcp.server` names, `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. Run the chosen variant as given rather than a tool you know. When no variant of an op works, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them.
   - **Source control:** keep the entry whose repository (from its `values`) is this checkout's `origin` in `git remote -v`. Outside `local` mode, with none, stop: `No configured source-control repository is this checkout's origin. Run /agent-flows:configure sourceControl, then re-run.` With one at `level` `read`, stop too: `The team uses <entry> read-only, so sync can't push or edit its pull requests. Run /agent-flows:configure <integration> to change that, or use /agent-flows:sync local.`
   - **Stacking:** use the first entry, if any. With none, the branch is a plain branch off the base.
   - **Issue tracker:** look issues up in every entry. Only entries at `level` `track` get issues filed or updated: file a new one in the first of those, unless the user or the repo's agent instructions name another. At `link`, an existing issue is only linked from the PR. With none, skip everything about issues.
   - **Error tracking:** every entry, if any. Only entries at `level` `resolve` resolve errors on merge; at `link`, errors are only linked.
3. **Pull request:** outside `local` mode, run the source-control entry's `currentPr` op. `<pr>` is `<number>:<open|merged|closed>:<true|false>` (the last part is whether it's a draft), or `none`. A merged or closed PR still counts: its state is what the issue follows. In `local` mode `<pr>` is `none`.
4. **Error refs:** outside `local` mode, scan the triggering message and this session for strings any error-tracking entry's `issueRef` op says name one of its issues. The conversation is the one input no fingerprint sees, so pass each as `--error-ref <ref>` (a short id, or the URL).
5. **Survey:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/sync.ts" survey <mode> --base <base> --pr <pr> [--error-ref <ref>]...` fetches the base (except in `remote` mode) and prints JSON: `branch`, `baseRef` (the ref to compare against), `onBase`, `dirty`, `ahead`, `behind`, `unpushed`, `head`, `pr`, `issue` (cached for this branch), `errorRefs` (every ref this branch has collected), `newErrorRefs` (not yet linked), `lastSyncedHead`, and the gate: `runLocal`, `runRemote`, `noop`. If it fails because HEAD is detached, stop and tell the user to check out a branch.

### Routing

These signals are the authority and **override the `**Next:**` block below**, which lists only each mode's next phase. Apply them first:

- `noop: true`: nothing this mode consumes changed since the last sync. Skip 1a and go straight to the `sync-report` skill with the current mode, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).
- `runLocal: false`: no commit, catch-up, or push to do. In default mode go to the `sync-remote` skill with the current mode, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one); in `local` mode go to the `sync-report` skill with the current mode, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).
- `runRemote: false` (in `remote` mode): the PR and issue already reflect this HEAD. Go to the `sync-report` skill with the current mode, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).
- Otherwise follow `**Next:**`.

### 1a. Find the issue

**Skip in `local` mode, with no issue tracker, or when `runRemote` is false and `onBase` is false** (nothing to write and no branch to name). A ref below means a string an issue-tracker entry's `issueRef` op matches; load each candidate with that entry's `getIssue` op, and fall through when it's missing or archived. Stop at the first match:

1. A ref in the argument, or in the triggering message.
2. The survey's `issue`: cached for this branch by an earlier sync. Load it with `getIssue`: someone may have closed it since. Canceled, or done while this branch's PR isn't merged, means the team dropped it: forget it (`finish --issue none` in the report) and keep looking, skipping that issue below.
3. A ref in the branch name.
4. A ref at the start of the PR title.
5. The PR body's `> Issue:` line.
6. Each entry's `findIssue` op with the line `> Branch: \`<branch>\``: the anchor sync writes into every issue it files or refreshes. Several matches is an anomaly: take the most recently updated one, and say so in the report.
7. A ref in recent user messages that is clearly about this work, not a passing mention.

Nothing found, and an entry at `track`: plan a new issue, filed by the remote writes. With entries only at `link`, there's no issue; carry on without one. Draft a 5-10 word title and a 1-3 sentence description of the work, from the PR title and body, then the session, then the commits. If all three are empty, ask: "What are you working on?" File it whatever the change is, a small or internal one included; an issue for every branch is the lockstep this command keeps.

**Next:**

- Mode `default` or `local`: invoke the `sync-local` skill with the current mode (`default` or `local`), forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).
- Mode `remote`: invoke the `sync-remote` skill with mode `remote`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).

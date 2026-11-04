---
description: Commit, catch up to the base branch, push, and keep the draft PR and its issue in step with the branch. Only for the named dev-flows sync workflow, not generic commit or push requests.
argument-hint: "[local|remote|help] [ISSUE-ID] [--tracker <entry>] [--tracker-project <name>]"
---

# /dev-flows:sync

Keeps the branch, its draft pull request, and its issue in step with the work. Safe to re-run: the survey compares everything a sync consumes against the last sync and skips the phases whose inputs didn't change. Every vendor-specific action goes through the repo's configured integrations (`/dev-flows:configure`), so the same skill works with any source-control host, stacking tool, issue tracker, or error tracker, or none of the optional ones.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `hooks.ts <subcommand>` | `run <point>... --flow <flow>` runs the repo's hooks at those points, in order, and prints what to do next: `done`, a task for you (`agent`), or a failure that stops the command (`stop`) |
| `configure.ts <subcommand>` | `get <path>... [--optional]` prints configured values (`null` for an unset one with `--optional`); `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Both exit 2 when the repo isn't configured for what's asked |
| `sync.ts <subcommand>` | `survey` reads git state and computes the no-op gate; `facts` prints the issue state and last-synced line for the remote writes; `splice` merges sync's block into a PR body; `description` readies an issue description for writing; `finish` records the sync. State lives in the repo's git common dir, per branch |

## Invariants

- **Act through the integrations' ops.** Pull requests, stacks, issues, and error issues are reached only through the ops `configure.ts integrations` returns, run as given. Plain `git` is fine for everything local.
- **Never change a pull request's draft or ready state.** Sync opens pull requests as drafts and leaves an existing one's state alone; marking it ready is the author's call.
- **Never rewrite pushed history yourself.** Without a stacking integration, catch up with `git merge`, never `git rebase`, so a push never needs force. With one, its `restack` and `submit` ops own the rebase and the push, and when `submit` fails, a `--force-with-lease` push of what it rebased is the only force allowed.
- **Never use destructive escapes** (`git reset --hard`, `git rebase --abort`, `git stash`, `git push --force` without `--force-with-lease`) to get out of a conflict.
- **Stage everything** with `git add -A` for a commit; for conflict resolution, stage each file with `git add <file>`, never `-A`.
- **Don't prompt** for anything inferable from the branch, commits, diff, session, or config.
- **Write only what sync owns.** In the PR body that's its block; in the issue description, the branch, error, and session lines, `## Status`, and the last-synced line; on the issue, the fields under Issue fields, within their rules. A section a person wrote stays as they wrote it.
- **Run the repo's hooks around this command.** Skip this when the mode is `help`, or when another dev-flows command is running this one (it runs its own). Once the mode is known, before the first step's work: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run before --flow sync --mode <mode>`. When the command ends, finished or stopped, just before its report or before telling the user why it stopped: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run after --flow sync --mode <mode> --outcome <success, when it did its job, else failure>`, leaving out a flag whose value isn't known yet. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop. At the end, a `stop` can't happen: report the `failures`. Say in the report which hooks ran at each point, what any task for you changed, and what failed.

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

> `/dev-flows:sync` keeps the branch, its draft PR, and its issue in step with the work on this branch. Safe to re-run.
>
> Modes:
>   - (no arg) -- default: commit, catch up to the base branch, push, and create or refresh the draft PR and its issue
>   - `local` -- local only: commit and catch up to the base branch. No push, PR, or issue.
>   - `remote` -- remote only: refresh the PR and its issue. No commits, catch-up, or push; never creates a PR.
>   - `help` -- show this and exit
>
> Pass an issue id (`/dev-flows:sync ENG-123`) to link the branch to that issue. `--tracker <entry>` files a new issue in that issue tracker, when the repo has several, and `--tracker-project <name>` puts the issue in that project. `--leave-issue` (merge passes it unless `merge.issueOnMerge` is `close`) links the issue but never files or changes one.
>
> A re-run with nothing changed since the last sync (no new commits, clean tree, base not advanced, PR state unchanged) stops at the no-op gate.
>
> It uses the integrations in `.agent-flows/config.json`: source control for the PR (required outside `local` mode), and, when configured, stacking for restack and push, an issue tracker for the issue, error tracking to link and resolve the errors the work fixes, and session sharing to link the session behind the work. Set them up with `/dev-flows:configure`.
>
> Before filing an issue, it searches open and recently closed ones for the same work (with `/dev-flows:create-tickets match`), and reuses a match or files a sub-issue under a larger one. The PR's Summary and Test plan and the issue's Status are regenerated each sync. The issue's Description is written once; the issue's state follows the PR (todo, in progress, in review, done, canceled), except that a done or canceled issue stays closed unless you say to reopen it. Its priority is set once and then left to people, with a due date asked for when the config's `tickets.dueDateRequired` covers that priority; its labels, estimate (on `tickets.estimateScale`, when set), cycle, and project follow the config and the repo's agent instructions. A tracker entry's `projects` can claim paths (`apps/mobile/**`): a new issue goes in the project whose paths the branch's changes match most, else the entry's default `project`. Say which project when that isn't right (`/dev-flows:sync --tracker-project Mobile`, or "this is in Mobile"): sync files the issue there, or moves it there when it's in another.

## 1. Survey

**Run only when mode is `default`, `local` or `remote`.**

Parse the argument for a mode keyword (`local`, `remote`, `help`), an optional issue id, `--leave-issue`, `--tracker <entry>`, and `--tracker-project <name>`. No keyword means default mode. Any other argument that starts with `--` is a flag this command doesn't take: name it, print the usage block from `help`, and stop, rather than running without it. A `--` inside pasted notes, a quoted value, or a command the notes quote (`git push --force`) is part of that text, not a flag. Read plain words the same way: "this is in Mobile" or "file it in the Mobile project" is `--tracker-project Mobile`, and "file it in <tracker>" is `--tracker <entry>`. `--tracker` names the issue-tracker entry a new issue is filed in (its `instance`, else its `integration`); when it names none at `level` `track`, say so, list the entries at `track`, and stop. `--tracker-project` is the project the branch's issue goes in: the user naming it, for the issue fields' project rule. With `--leave-issue` (`/dev-flows:merge` passes it when `merge.issueOnMerge` isn't `close`), find and link the issue as usual, but file none (skip 8 of 1a and 3b) and leave it as it is (skip 3d).

| Mode | Survey | Local git work | Remote writes |
|------|--------|-------|--------|
| default | Full | When `runLocal` | When `runRemote` |
| `local` | Skip 1a | When `runLocal`, never pushes | Never |
| `remote` | Full | Never | When `runRemote`, never creates a PR |

The issue tracks the work (a stable Description plus a regenerated Status); the PR describes the change (a regenerated Summary and Test plan). Don't put Status in the PR or the Test plan in the issue.

1. **Base branch:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" get repo.baseBranch` prints `{"values": {"repo.baseBranch": "<base>"}}`. If it exits with status 2 and prints `"configured": false`, stop this command here. Relay its `message`: the repo isn't set up for dev-flows yet, its config is invalid (`issues`), or it doesn't set what this command needs (`missing`: config paths, or capabilities with no integration). Tell the user to run `/dev-flows:configure` (naming the missing sections or capabilities, if any) and then re-run this command. Don't guess the values instead. Then `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" get merge.issueOnMerge --optional`: `<issueOnMerge>`, `close`, `tracker`, or `leave` (`null` reads as `close`); `leave` means merging should leave the issue's state alone. Then `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" get sync.requireBase sync.linkUnverified --optional`: `<requireBase>` and `<linkUnverified>`, each true or false (`null` reads as false).
2. **Integrations:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations sourceControl stacking issueTracker errorTracking sessions --optional` prints every entry the repo configured for each. Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `script` (an adapter: the op as code, built in or the repo's own; run it, and when it exits 3 it can't run here, so go on to the next), `mcp` when this session has tools from an MCP server whose name contains `access.mcp.server` (tools that are deferred, or from a server still connecting, count: search for them with your tool search before deciding they're missing), `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. An op given as `unsupported` is one that integration has nothing for: skip what needs it, and say so in the report with its reason. Run the chosen variant as given rather than a tool you know. When no variant of an op works, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them.
   - **Source control:** keep the entry whose repository (from its `values`) is this checkout's `origin` in `git remote -v`. Outside `local` mode, with none, stop: `No configured source-control repository is this checkout's origin. Run /dev-flows:configure sourceControl, then re-run.` With one at `level` `read`, stop too: `The team uses <entry> read-only, so sync can't push or edit its pull requests. Run /dev-flows:configure <integration> to change that, or use /dev-flows:sync local.`
   - **Stacking:** use the first entry, if any. With none, the branch is a plain branch off the base.
   - **Issue tracker:** look issues up in every entry. Only entries at `level` `track` get issues filed or updated: file a new one in the one `--tracker` names, else the first of those, unless the user or the repo's agent instructions name another. At `link`, an existing issue is only linked from the PR. With none, skip everything about issues.
   - **Error tracking:** every entry, if any. Only entries at `level` `resolve` resolve errors on merge; at `link`, errors are only linked.
   - **Session sharing:** the first entry, if any. With none, nothing is shared.
3. **Pull request:** outside `local` mode, run the source-control entry's `currentPr` op. `<pr>` is `<number>:<open|merged|closed>:<true|false>` (the last part is whether it's a draft), or `none`. A merged or closed PR still counts: its state is what the issue follows. In `local` mode `<pr>` is `none`. **With `<requireBase>` and an open PR:** its base branch must be `<base>`, or, with a stacking entry, the branch's parent in its stack (its `parent` op). Anything else: stop, `Pull request <N> targets <its base>, not <base>. Retarget it to <base>, then re-run /dev-flows:sync.` A pull request opened by hand often targets the host's default branch, and catching it up to that branch, or merging it there, can ship what the base exists to hold back.
4. **Error refs:** outside `local` mode, scan the triggering message, this session, and the PR body's link lines (quoted with `> `, or plain when the config's `sync.quoteLinks` is false; an earlier sync tool may have written its own, named for the error tracker) for strings any error-tracking entry's `issueRef` op says name one of its issues. The conversation is the one input no fingerprint sees, so pass each as `--error-ref <ref>` (a short id, or the URL).
5. **Survey:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/sync.ts" survey <mode> --base <base> --pr <pr> [--error-ref <ref>]...` fetches the base (except in `remote` mode) and prints JSON: `branch`, `baseRef` (the ref to compare against), `onBase`, `dirty`, `ahead`, `behind`, `unpushed`, `head`, `pr`, `issue` (cached for this branch, or left for it by an earlier sync tool's state: bitfab-dev's in the worktree, or the files the config's `sync.adoptState` names), `errorRefs` (every ref this branch has collected), `newErrorRefs` (not yet linked), `lastSyncedHead`, `format` (how sync writes this branch's lines and title: the config's `sync` section, then the format the branch was last written in; see 3c), `projects` (for each issue-tracker entry whose `values.projects` give paths, by its `instance`, else its `integration`: `{"project", "files", "tied"}`, the project whose paths match the most of the branch's changed files, with `tied` the ones that matched as many (name them in the report when the issue is filed there), or `null` when none match; empty when no entry gives paths), and the gate: `runLocal`, `runRemote`, `noop`. If it fails because HEAD is detached, stop and tell the user to check out a branch; because `origin/<base>` doesn't exist after the fetch, relay its message and stop: without it, every count against the base is a guess.

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
4. A ref in the PR title where the survey's `format.prTitle` puts `{issueId}`: at its start (`{issueId}: {title}`), at its end (`{summary} ({issueId})`, the ref in the closing parentheses), or wherever else the template has it; with no template, at the start.
5. The PR body's issue line, in any form sync writes it: quoted (`> Issue:`) or plain (`Issue:`, with `format.quoteLinks` false), labeled `Issue` or named for the tracker, linking `<ID>` with the title after the link, or giving the issue's bare URL. Also the issue link an earlier sync tool put at the top of the body (a line named for the tracker, quoted or not, linking `<ID>` with the title after the link, linking `<ID>: <title>` as older syncs wrote it, or a bare URL).
6. Each entry's `findIssue` op with `<branch>` this branch: it finds the `> Branch:` anchor line sync writes into every issue it files or refreshes, and the bare one earlier sync tools wrote. Several matches is an anomaly: take the most recently updated one, and say so in the report.
7. A ref in recent user messages that is clearly about this work, not a passing mention.
8. **The same work, filed by someone else.** Only with an entry at `track`, which is where a new issue would go. Many issues for a branch's work were filed from planning notes (by `/dev-flows:create-tickets`, say), by someone else, or long ago, and carry no `> Branch:` line. Draft the new issue first: a 5-10 word title and a 1-3 sentence description of the work, from the PR title and body, then the session, then the commits (if all three are empty, ask: "What are you working on?"). Then run the `/dev-flows:create-tickets` skill with `match --branch <branch> <title>. <description>`: it searches every issue-tracker entry the way create-tickets does before filing, judges each candidate against this branch's work, and files and changes nothing. Its line for the item decides:
   - **`match <ID>`:** the same work, open, with no pull request attached: that's this branch's issue. 3d adds the `> Branch:` line, so the next sync finds it directly.
   - **`sub-issue of <ID>`:** part of a larger open issue, or the same work under another pull request: plan a new issue as a sub-issue of it (`<parent>`), so each pull request has its own issue.
   - **`new`:** plan a new issue from the draft.

   Name each `closed:` issue it lists in the report (never this branch's issue: its work is finished), and each `also tracked:` one. On `search skipped`, plan a new issue and say in the report that the search was skipped.

**An issue the tracker can't load** (with `<linkUnverified>`): when a ref from 1-5 names an issue of an entry at `link`, and `getIssue` can't answer for it (an error, a token or MCP server for another workspace, an outage), not one that says it's missing or archived, take it as the branch's issue anyway, unverified: link it in 3c with the URL the ref gave, else the URL the entry's `issueRef` op describes, filled in from its `values` (a workspace, a site), else the bare id with no URL; leave the title out. Say in the report that it wasn't verified, and why. Never for an entry at `track`: sync would write to an issue it can't see.

Nothing found, and an entry at `track`: the new issue planned in 8 is filed by the remote writes. With entries only at `link`, there's no issue; carry on without one. File it whatever the change is, a small or internal one included; an issue for every branch is the lockstep this command keeps.

**Next:**

- Mode `default` or `local`: invoke the `sync-local` skill with the current mode (`default` or `local`), forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).
- Mode `remote`: invoke the `sync-remote` skill with mode `remote`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).

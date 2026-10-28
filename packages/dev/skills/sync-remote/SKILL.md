---
name: sync-remote
description: Remote sync phase of the /dev-flows:sync flow. Invoked by the sync flow; not run directly
user-invocable: false
---

# /dev-flows:sync: Remote sync

**Mode:** you were dispatched with a mode (`default` or `remote`); which steps apply and where they route below depend on it.

**Run only when mode is `default` or `remote`.**

## 1. Remote writes

**Skip when the survey said `runRemote: false`**, and go straight to the `sync-report` skill with the current mode, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one). In default mode local work always sets it, since it moves HEAD.

Order matters: the session link exists before the PR and issue carry it (3a first), the issue exists before the PR body links it (3b before 3c), and the issue's state follows the PR (3d after 3c).

Re-run the source-control entry's `currentPr` op for a fresh `<pr>` (local work may have opened one), then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/sync.ts" facts --base <base> --pr <pr>
```

It prints `workState` (the issue's state, from the PR and the branch: `todo` with nothing ahead of the base, `in progress` with a draft or no PR, `in review` when ready, `done` when merged, `canceled` when closed), `lastSyncedLine` (the marker that ends the PR block and the issue's Status, used verbatim), and `updateKind`. Use them as given; don't derive the state yourself.

- **`updateKind: full`:** run 3a-3e. Its `commits` and `diffStat` are the main inputs for the prose, with the session; read the full diff only when you can't write an accurate summary without it.
- **`updateKind: metadata-only`:** HEAD hasn't moved since the last remote sync; only the PR's state or the error refs did. Skip 3a (there's no new work to share), and don't regenerate the Summary, Test plan, or Status: in 3c and 3d, update only the `> ` link lines, the issue's state, and the last-synced line, and leave the issue fields alone. Then 3e.

Files go in the worktree's private git dir, `<dir>` from `git rev-parse --absolute-git-dir` plus `/agent-flows`, so they never land in the tree.

### 3a. Session

With a session-sharing entry: run its `shareSession` op and note the URL, for the session lines in 3c and 3d. Sharing the same session again updates its link, so a re-run doesn't pile up copies. When it fails (not signed in, the tool missing, a network error), say so in the report and carry on: sharing is never worth stopping a sync for, and the lines below keep the link from an earlier sync.

### 3b. Issue

With an issue tracker and a new issue planned in 1a: file it with that entry's `createIssue` op, using the description template in 3d, `<parent>` when 1a planned it as a sub-issue, and `<fields>` from the issue fields below. Note its id: `finish` caches it for the next sync.

#### Issue fields

For an entry at `track`, on filing and on every full update; the same rules `/dev-flows:create-tickets` files by. Take each field from, in order: the user or this session, the repo's agent instructions (`AGENTS.md`, `CLAUDE.md`, and the docs they point to for ranking or filing work), then the entry's `values` of the same name. With none of those, leave the field out. Pass as `<fields>` only the fields that change.

- **Priority:** set it when filing, and on an update only when the issue has none. Never change a priority the issue already has, since a person may have set it, unless the user asks to in this session.
- **Labels:** when there's a set to pick from (the agent instructions' or `values.labels`), exactly one of it that fits the kind of work. Judge it again on each full update: keep the current one unless another fits strictly better, and never add or remove labels outside the set.
- **Estimate:** when the agent instructions or `values.estimate` ask for one, the size of the work on the team's scale, judged again on each full update.
- **Cycle:** the one the user names (`current`, `next`, or a date inside it); else, when the agent instructions or `values.cycle` ask for cycles, `current`. Set it when filing, or on an update when the issue has no cycle and isn't done or canceled. Never move an issue out of a cycle it's in unless the user asks.
- **Project:** the one the user or the agent instructions name, else a new sub-issue's parent's, else `values.project`: when filing, or on an update when the issue has none. Never move an issue out of a project it's in unless the user asks.
- **Assignee:** only the person the user names; left out, a new issue goes to the person running this. Never reassign an issue unless the user asks.
- **Due date:** only when the user gives one. Read a weekday deadline ("Friday", "Mon EOD") as today when today is that weekday, else the next one, and say which date you chose. Never clear one unless the user asks (`null`).

### 3c. Pull request

Sync owns one block of the PR body:

```markdown
> Issue: [<ID>](<issue URL>) <issue title>   (one line per linked issue; omit with no issue tracker)
> Errors: <short id> ([<title>](<URL>))   (one line per error ref; omit when there are none)
> <session-sharing name>: [Session](<session URL>)   (omit with no session link)

<the issue tracker's prLink form, when it goes in the body: `Fixes <ID>` or `Part of <ID>`>

## Summary

- <what this change does and why, 1-3 bullets>

<before and after, when the change alters behavior that already existed>

## Test plan

- [ ] <how to verify the change works>
- [ ] <an edge case worth checking>

<lastSyncedLine>
```

- **Links:** a `> Issue:` line for the issue, its link text the bare id with the title after the link (a tracker reading the PR for the issue takes the link text as the id, so an id with the title inside it doesn't link, and merging doesn't close the issue), an `> Errors:` line for each of the survey's `errorRefs`, and a session line, named for the session-sharing entry (its `name`), with the URL 3a shared. When 3a didn't share one, keep the session line the body already has, from this block or one an earlier sync tool wrote. When the tracker's `prLink` op puts its link in the body, add that line too: the closing form for an entry at `track` (merging closes the issue even if sync doesn't run again), the linking-only form at `link`, which never changes the issue.
- **The survey's `format`:** with `linkLabels` `integration`, label the issue and error lines with the `name` of the entry each links to (`> <tracker name>:` in place of `> Issue:`), in this block and in 3d. With an `errorVerb`, each error line starts with it (`> Errors: <errorVerb> <short id> ([<title>](<URL>))`). `blockMarkers` is `splice`'s to apply; write the block the same either way.
- **The repo's PR template:** when the repo has one (`.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, or `docs/` or the root with either name), the block follows it instead of the Summary and Test plan headings: the template's sections in its order, filled in from the change. A "what and why" or summary section gets the Summary's content, a test section the Test plan's, and a checklist keeps its items, checked only for what's true and verified, with a short note where an item doesn't apply. Drop the template's HTML comments. The link lines stay on top and the last-synced line at the end.
- **Summary:** regenerated every sync, 1-3 bullets on what the change does and why. Don't restate the issue (the link does) or add progress (that's the issue's Status).
- **Before and after:** when the change alters behavior that already existed (a fix, or anything that changes what a person sees), add a bolded **Before** (what a person saw happen: the input, the result, whether anything was raised) and a bolded **After**. One or two changes get a short paragraph each; three or more get a table with Before and After columns, one row per change. Say which paths are unchanged. Skip it for a change that only adds something new.
- **Test plan:** regenerated every sync, 2-5 checkboxes from what changed. A single bullet is fine for a tiny change.

Write the current PR body (from `currentPr`; empty when there's no PR) to `<dir>/pr-body.md` and the new block to `<dir>/pr-block.md`, then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/sync.ts" splice --body <dir>/pr-body.md --block <dir>/pr-block.md [--no-markers] > <dir>/pr-new.md
```

It replaces the old block, or puts the block on top of a body that has none, and keeps everything else. A body an earlier sync tool wrote without the block's markers (link lines on top, a Summary and Test plan, a last-synced line) has those replaced too, so it doesn't end up with two of each. Pass `--no-markers` when the survey's `format.blockMarkers` is false: it writes the block without markers, the way that tool does, so the two can take turns on one PR.

With `format.prTitle` and an issue, the title is that template, with `{issueId}` and `{title}` the issue's id and title. Otherwise it follows the repo's convention: its agent instructions first, then the shape of recent subjects on the base (`git log -20 --format=%s <baseRef>`, which are PR titles when the repo squash-merges). Put the issue id in it only when the tracker's `prLink` op says the title is the only place that links them, keeping the rest of the convention. Keep the existing title when it still fits (with a template, only when it matches it). Quote the title for the shell: single quotes, with any `'` written as `'\''`.

- **PR exists:** when the body or title changed, the `prEdit` op with `<body-file>` `<dir>/pr-new.md`.
- **No PR, default mode:** the `prCreate` op, with `<base>` the `<parent>` 2b found (`<base>` when 2b didn't run).
- **No PR, `remote` mode:** skip. Remote mode never creates a PR.

### 3d. Issue

With an issue in an entry at `track` (at `link`, leave the issue alone; the PR's link is all): build its description from this template:

```markdown
> Branch: `<branch>`
> Errors: <short id> ([<title>](<URL>))   (one line per error ref; omit when there are none)
> <session-sharing name>: [Session](<session URL>)   (omit with no session link)

## Description

<the stable "what" of the work, 1-3 sentences. Written once, never rewritten by sync>

## Status

**Done:**

- <finished items>

**Remaining:**

- <what's left>

<lastSyncedLine>
```

- **`> Branch:` line:** always, exactly as shown (the backticks keep the tracker from turning an id in the branch name into a link), in place of a bare `> Branch:` line an earlier sync tool wrote. It's the anchor 1a's `findIssue` looks for.
- **Error lines:** as in the PR block, labeled and worded by the survey's `format`.
- **Session line:** as in the PR block: the URL 3a shared, else the session line the description already has.
- **Other `> ` lines** sync doesn't write (a planning link, say): keep them, below sync's.
- **Description:** keep the existing one. Write it only when the issue has none (a new issue, or one filed without it).
- **Status:** regenerated every sync, 3-8 plain bullets (no checkboxes) across Done and Remaining, about the implementation only, never review, merge, or deploy. When the implementation is complete, Remaining is `None. Implementation complete; the rest is tracked on the PR.`
- Keep any other section a person wrote.

Then the entry's `updateIssue` op with the title (keep the existing one unless a new one fits strictly better, and keep any mark at its start, such as the team's `tickets.blockerMark` (an emoji like 🛑): it flags the issue for the team), the description, `<state>` `workState`, and `<fields>` from the issue fields in 3b.

**A closed issue stays closed.** When the issue's workflow state (from `getIssue` in 1a; load it now when 1a didn't) is done or canceled (a duplicate counts as canceled) and `workState` is a different stage, leave `<state>` out unless the user says to reopen it. Ask once: "<ID> is <state>. Sync would move it to <workState>. Reopen it?" Only an explicit yes passes `workState`. A no, no answer, or a run nobody can answer (a scheduled or unattended sync) leaves the state alone, and the report says "<ID> kept at <state>; sync would have moved it to <workState>". Every other write still runs. Never set a state over a done or canceled one without that yes.

### 3e. Errors

When `workState` is `done` (the PR merged): resolve each of the survey's `errorRefs` with the `resolveIssue` op of the error-tracking entry whose `issueRef` matches it, when that entry is at `resolve`. At `link`, leave it for the team, and list it in the report. Resolving is idempotent. Use the op's first variant that works here: an entry reached through its MCP server needs neither the CLI nor a token. A ref no entry matches, a call that fails, or one no variant can reach goes in the report as `Needs manual resolve: <ref>`, with what would make it work.

**Next:**

- Mode `default` or `remote`: invoke the `sync-report` skill with the current mode (`default` or `remote`), forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).

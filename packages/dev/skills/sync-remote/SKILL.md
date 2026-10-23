---
name: sync-remote
description: Remote sync phase of the /agent-flows:sync flow. Invoked by the sync flow; not run directly
user-invocable: false
---

# /agent-flows:sync: Remote sync

**Mode:** you were dispatched with a mode (`default` or `remote`); which steps apply and where they route below depend on it.

**Run only when mode is `default` or `remote`.**

## 1. Remote writes

**Skip when the survey said `runRemote: false`**, and go straight to the `sync-report` skill with the current mode, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one). In default mode local work always sets it, since it moves HEAD.

Order matters: the issue exists before the PR body links it (3a before 3b), and the issue's state follows the PR (3c after 3b).

Re-run the source-control entry's `currentPr` op for a fresh `<pr>` (local work may have opened one), then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/sync.ts" facts --base <base> --pr <pr>
```

It prints `workState` (the issue's state, from the PR and the branch: `todo` with nothing ahead of the base, `in progress` with a draft or no PR, `in review` when ready, `done` when merged, `canceled` when closed), `lastSyncedLine` (the marker that ends the PR block and the issue's Status, used verbatim), and `updateKind`. Use them as given; don't derive the state yourself.

- **`updateKind: full`:** run 3a-3d. Its `commits` and `diffStat` are the main inputs for the prose, with the session; read the full diff only when you can't write an accurate summary without it.
- **`updateKind: metadata-only`:** HEAD hasn't moved since the last remote sync; only the PR's state or the error refs did. Don't regenerate the Summary, Test plan, or Status: in 3b and 3c, update only the `> ` link lines, the issue's state, and the last-synced line. Then 3d.

Files go in the worktree's private git dir, `<dir>` from `git rev-parse --absolute-git-dir` plus `/agent-flows`, so they never land in the tree.

### 3a. Issue

With an issue tracker and a new issue planned in 1a: file it with that entry's `createIssue` op, using the description template in 3c. Note its id: `finish` caches it for the next sync.

### 3b. Pull request

Sync owns one block of the PR body:

```markdown
> Issue: [<ID>: <issue title>](<issue URL>)   (one line per linked issue; omit with no issue tracker)
> Errors: <short id> ([<title>](<URL>))   (one line per error ref; omit when there are none)

<the issue tracker's prLink form, when it goes in the body: `Fixes <ID>` or `Part of <ID>`>

## Summary

- <what this change does and why, 1-3 bullets>

<before and after, when the change alters behavior that already existed>

## Test plan

- [ ] <how to verify the change works>
- [ ] <an edge case worth checking>

<lastSyncedLine>
```

- **Links:** a `> Issue:` line for the issue, and an `> Errors:` line for each of the survey's `errorRefs`. When the tracker's `prLink` op puts its link in the body, add that line too: the closing form for an entry at `track` (merging closes the issue even if sync doesn't run again), the linking-only form at `link`, which never changes the issue.
- **The repo's PR template:** when the repo has one (`.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, or `docs/` or the root with either name), the block follows it instead of the Summary and Test plan headings: the template's sections in its order, filled in from the change. A "what and why" or summary section gets the Summary's content, a test section the Test plan's, and a checklist keeps its items, checked only for what's true and verified, with a short note where an item doesn't apply. Drop the template's HTML comments. The link lines stay on top and the last-synced line at the end.
- **Summary:** regenerated every sync, 1-3 bullets on what the change does and why. Don't restate the issue (the link does) or add progress (that's the issue's Status).
- **Before and after:** when the change alters behavior that already existed (a fix, or anything that changes what a person sees), add a bolded **Before** (what a person saw happen: the input, the result, whether anything was raised) and a bolded **After**. One or two changes get a short paragraph each; three or more get a table with Before and After columns, one row per change. Say which paths are unchanged. Skip it for a change that only adds something new.
- **Test plan:** regenerated every sync, 2-5 checkboxes from what changed. A single bullet is fine for a tiny change.

Write the current PR body (from `currentPr`; empty when there's no PR) to `<dir>/pr-body.md` and the new block to `<dir>/pr-block.md`, then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/sync.ts" splice --body <dir>/pr-body.md --block <dir>/pr-block.md > <dir>/pr-new.md
```

It replaces the old block, or puts the block on top of a body that has none, and keeps everything else.

The title follows the repo's convention: its agent instructions first, then the shape of recent subjects on the base (`git log -20 --format=%s <baseRef>`, which are PR titles when the repo squash-merges). Put the issue id in it only when the tracker's `prLink` op says the title is the only place that links them, keeping the rest of the convention. Quote the title for the shell: single quotes, with any `'` written as `'\''`. Keep the existing title when it still fits.

- **PR exists:** when the body or title changed, the `prEdit` op with `<body-file>` `<dir>/pr-new.md`.
- **No PR, default mode:** the `prCreate` op, with `<base>` the stacking integration's `parent` when stacked, else `<base>`.
- **No PR, `remote` mode:** skip. Remote mode never creates a PR.

### 3c. Issue

With an issue in an entry at `track` (at `link`, leave the issue alone; the PR's link is all): build its description from this template:

```markdown
> Branch: `<branch>`
> Errors: <short id> ([<title>](<URL>))   (one line per error ref; omit when there are none)

## Description

<the stable "what" of the work, 1-3 sentences. Written once, never rewritten by sync>

## Status

**Done:**

- <finished items>

**Remaining:**

- <what's left>

<lastSyncedLine>
```

- **`> Branch:` line:** always, exactly as shown (the backticks keep the tracker from turning an id in the branch name into a link). It's the anchor 1a's `findIssue` looks for.
- **Description:** keep the existing one. Write it only when the issue has none (a new issue, or one filed without it).
- **Status:** regenerated every sync, 3-8 plain bullets (no checkboxes) across Done and Remaining, about the implementation only, never review, merge, or deploy. When the implementation is complete, Remaining is `None. Implementation complete; the rest is tracked on the PR.`
- Keep any other section a person wrote.

Then the entry's `updateIssue` op with the title (keep the existing one unless a new one fits strictly better), the description, and `<state>` `workState`.

### 3d. Errors

When `workState` is `done` (the PR merged): resolve each of the survey's `errorRefs` with the `resolveIssue` op of the error-tracking entry whose `issueRef` matches it, when that entry is at `resolve`. At `link`, leave it for the team, and list it in the report. Resolving is idempotent. A ref no entry matches, or a call that fails, goes in the report as `Needs manual resolve: <ref>`.

**Next:**

- Mode `default` or `remote`: invoke the `sync-report` skill with the current mode (`default` or `remote`), forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).

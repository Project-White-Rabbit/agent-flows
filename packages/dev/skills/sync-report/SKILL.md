---
name: sync-report
description: Report phase of the /dev-flows:sync flow. Invoked by the sync flow; not run directly
user-invocable: false
---

# /dev-flows:sync: Report

**Mode:** you were dispatched with a mode (`default` or `local` or `remote`); which steps apply and where they route below depend on it.

**Run only when mode is `default`, `local` or `remote`.**

## 1. Report

First, on every path (the no-op gate included), record the sync so the next one can skip what's unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/sync.ts" finish --base <base> --pr <pr> [--remote] [--issue <id>] [--linked-ref <ref>]...
```

- `<pr>`: the latest from `currentPr` (`none` in `local` mode).
- `--remote`: in default and `remote` mode, when the remote writes updated the PR and issue, or the gate said they were already current. Never in `local` mode, and not when the remote writes stopped partway.
- `--issue`: the issue's id, when there is one; `none` when 1a dropped a cached issue the team closed.
- `--linked-ref`: each error ref now in the PR's error lines.

**The stacking tool's link:** with a stacking entry and a pull request, when `submit` printed no URL in the tool's own app (it pushed nothing, failed, or didn't run), its `prUrl` op with `<url>` the pull request's URL gives it; `null` means there's none.

**If this run hit the no-op gate:** outside `local` mode, with an open PR, run the source-control entry's `prMergeability` op once (`pending` counts as clean), since the base can move under a branch that didn't change: nothing changed is never the same as safe to merge. When it's `conflicting` or `behind`, lead with `<branch> no longer merges cleanly into <base> (<state>). Run /dev-flows:sync local to catch it up.` When the op fails, lead with `Couldn't read whether <branch> still merges cleanly into <base>: <error>.`, never with nothing. Then print only `Already synced: nothing changed since <short lastSyncedHead>.` with the PR's URL (and the stacking tool's link) and the issue's URL, and stop.

Otherwise lead with anything that needs the user's attention (an unresolved conflict, a mergeability problem, a failed write, an ambiguous issue match, a skipped issue search, a failed session share, errors to resolve by hand), then print:

- **Mode** that ran, and what was skipped and why (the local git work in `remote` mode or on `runLocal: false`; 1a and the remote writes in `local` mode or on `runRemote: false`).
- **Branch:** existing or created; what was committed; whether it caught up to the base, or was left behind it with `--no-catch-up` (and any conflicts resolved, by file: a resolution nobody sees is one nobody checked); whether it was pushed.
- **PR:** URL (and the stacking tool's link, when there is one), draft or ready, existing or created, and its mergeability; and a `submit` that failed, with the push it fell back to.
- **Issue:** id, URL, and state (and, when it was closed and stayed closed, the state sync would have set); existing, found by the search (and which issue matched), created, or created as a sub-issue (of which); updated, or left alone with `--leave-issue`; or none, with no issue tracker configured. The fields set or changed (priority, labels, estimate, cycle, project, due date, the assignee with `tickets.assignOnSync`, the blocker mark), a priority left without the due date `tickets.dueDateRequired` asks for, and a closed issue the search found for the same work; for a new sub-issue, what its parent took from it (`tickets.parentFollowsSubIssues`), and the planning document it was recorded in (`tickets.planningDoc`), as a link.
- **Session:** the shared URL, or skipped or failed, and why.
- **Errors:** refs linked, and any resolved.

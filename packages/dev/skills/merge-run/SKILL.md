---
name: merge-run
description: Run phase of the /dev-flows:merge flow. Invoked by the merge flow; not run directly
user-invocable: false
---

# /dev-flows:merge: Run

## 1. Sync

Skip this step when the pre-flight already ran sync.

Otherwise run the `/dev-flows:sync` skill with no arguments: invoke it, don't redo its steps. The tree is clean, so it commits nothing, but it catches the branch up to its base, pushes what's unpushed, and refreshes the pull request body and its issue. When it stops (a conflict it needs you for), stop too and pass its message on; nothing has merged.

## 2. Merge

The entries, `<base>`, `<branch>`, `<N>`, the chain, the scope, and the method are from the *Pre-flight* section of the `merge` skill.

### Mark ready

When pull request <N> is a draft, the `prReady` op. For `stack`, the same for every other draft in the chain: a draft can't merge, so one left below would stop the chain partway.

### Wait for CI

`git fetch origin <branch>`. `<sha>` is `git rev-parse HEAD`; when it isn't `git rev-parse origin/<branch>`, stop: `<branch> has commits that aren't pushed. Run /dev-flows:sync, then re-run /dev-flows:merge.` What merges is the pushed head, so that's what CI must pass on.

Run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci start --sha <sha>`, then wait for the checks: with a `script` variant of the `checks` op that runs here,

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci wait --sha <sha> --timeout 1800 --command '<the checks op's script variant, with <sha> filled in>'
```

It polls every 30 seconds, prints `[ready-ci]` progress to stderr and the final report to stdout. Relay its progress in one line at least once a minute. When the host limits how long one command runs, add `--max-wait <a bit under that limit>` and run it again until it settles; the deadline stays the one `ci start` set. Without a `script` variant, every 30 seconds run the `checks` op for `<sha>`, write its JSON to a file, and run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci record --sha <sha> --file <file> --timeout 1800`, until it says `settled` or `timedOut`.

The report's `noChecks` means the repo runs no CI on the commit: go on. `timedOut`: stop with the pull request open, listing `pending`. Settled with `failures` (failed or cancelled checks): go on to the merge state below, which says whether the host needs them; keep their names for the report.

### Merge state

The `prMergeState` op for <N>:

- `ready`: merge. Failed checks that it lets through are ones the base doesn't require: list them in the report.
- `pending`: wait 3 seconds and ask again, up to 3 times; still pending, stop.
- `blocked`: stop with its reasons. Failed checks: `Fix them with /dev-flows:ready, then re-run /dev-flows:merge.` A review or approval: the people who own it.
- `conflicting` or `behind`: stop, `Run /dev-flows:sync to catch <branch> up to its base, then re-run /dev-flows:merge.`

A stop here leaves the pull request open and unmerged. Push nothing from here to the merge.

### Merge one branch

For `branch`: the `prMerge` op with <N>, the method, and `<sha>`. When the host refuses (a moved head, a rule, a method the repository doesn't allow), stop and show its reason as given; for a method it doesn't allow, name the ones to pass instead when it says. Never retry with a bypass.

Then the `prMetadata` op for <N>: its state must be merged. If it isn't, stop: nothing after this runs for an unmerged pull request.

### Merge the chain

For `stack`, instead: the stacking entry's `mergeStack` op. It can take minutes; run it in the foreground. Then the `branchPr` op for every branch in the chain. All merged: go on. Otherwise stop and say plainly that **part of the chain is merged**: list which pull requests merged and which didn't, with the op's output. The usual next step is `/dev-flows:sync` to restack what's left, fix the blocked one, and re-run `/dev-flows:merge`. When it says local branches differ from their remotes, it refused rather than land unpushed work: `/dev-flows:sync`, then re-run.

### Close out

Run the `/dev-flows:sync` skill with the argument `remote`. With the pull request merged, it moves the issue to done and resolves the errors the pull request fixed, as far as each integration's `level` allows. A failure here goes in the report; the merge stands.

### Delete the remote branch

Only after the host said merged. When `above` is more than 0, keep it: the pull requests stacked on top target it until they're restacked; say so in the report. Otherwise `git push origin --delete <branch>`; one that says the remote ref doesn't exist was already deleted (the host may do it on merge), which counts as done. Never `git branch -D`, never switch branches, and never remove this worktree: the local branch stays for the user to clean up.

## 3. Report

Lead with anything that needs the user's attention: a stop and its reason, a chain that merged partway, failed checks the host let through, a failed close-out. Then:

- **Merged:** the pull request's number and URL; for a chain, every pull request bottom first, the current branch marked.
- **Scope:** `branch` or `stack`, and how it was decided (an argument, the user's answer, or nothing below this branch). Branches still open above this one, and that `/dev-flows:sync` on each restacks them.
- **Method:** the method and why; for a chain, `set by the stacking tool or the host`, and a method argument that wasn't used.
- **CI:** the commit it passed on (short sha), how long it waited, and any failed checks the host didn't require.
- **Close-out:** the issue and its state, errors resolved, and any to resolve by hand, from the remote sync.
- **Remote branch:** deleted, already gone, or kept (and why).
- **Local:** still on `<branch>`; deleting it and its worktree is the user's call.

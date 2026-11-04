---
name: merge-run
description: Run phase of the /dev-flows:merge flow. Invoked by the merge flow; not run directly
user-invocable: false
---

# /dev-flows:merge: Run

## 1. Sync

Skip this step when the pre-flight already ran sync.

Otherwise, by `<syncMode>` from the *Pre-flight* section of the `merge` skill:

- **`full`:** run the `/dev-flows:sync` skill with no arguments: invoke it, don't redo its steps. The tree is clean, so it commits nothing, but it catches the branch up to its base, pushes what's unpushed, and refreshes the pull request body and its issue.
- **`remote`:** nothing in merge pushes, so first `git fetch origin <branch>`: when `git rev-parse HEAD` isn't `git rev-parse origin/<branch>`, stop, `<branch> has commits that aren't pushed, and merge.sync is remote, so merge won't push them. Run /dev-flows:sync, then re-run /dev-flows:merge.` Then run the `/dev-flows:sync` skill with the argument `remote`: it refreshes the pull request body and its issue, and never commits, catches up, or pushes. A branch that's behind its base or conflicting stops at the merge state below.

When it stops (a conflict it needs you for), stop too and pass its message on; nothing has merged.

## 2. Merge

The entries, `<base>`, `<branch>`, `<N>`, the chain, the scope, and the method are from the *Pre-flight* section of the `merge` skill.

### Mark ready

When pull request <N> is a draft, the `prReady` op. For `stack`, the same for every other draft in the chain: a draft can't merge, so one left below would stop the chain partway.

### The repo's `beforeCi` hooks

`node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run merge.beforeCi --flow merge --mode default --branch <branch> --pr <N> --prs '<numbers>'`. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop. These are for a commit that must land with the merge (a changelog entry): a hook may commit and push it, so CI below runs on it, and the repo's CI can check only what it adds. After them, `git status --porcelain` must print nothing (a hook that left changes uncommitted: stop, as gate 2 of 1b does).

### Wait for CI

`git fetch origin <branch>`. `<sha>` is `git rev-parse HEAD`; when it isn't `git rev-parse origin/<branch>`, stop: `<branch> has commits that aren't pushed. Run /dev-flows:sync, then re-run /dev-flows:merge.` What merges is the pushed head, so that's what CI must pass on.

### Recorded evaluation

`node "${CLAUDE_PLUGIN_ROOT}/src/commands/evaluate.ts" gate --base origin/<the pull request's base>` reads `merge.requireEvaluation` and the branch's recorded verdict, and prints `gate`, its `reason`, `rerun` (on a `stop` a fresh evaluation can settle), and the `record` (its `verdict`, `summary`, and `sha`):

- `off`: the repo doesn't gate on it. Go on.
- `pass`: go on. When `carried` is true, the verdict was on an earlier commit whose files changed the same way (the branch only took in its base), and now names `<sha>`: say so in the report.
- `ask`: show the `summary` lines and ask `The evaluation of <short sha> flagged these. Merge anyway?`; merge only on an explicit yes, and note it in the report. Anything else stops.
- `stop` with `rerun` true: no verdict is recorded, or it's on another commit, so evaluate it now. Say why (its `reason`), then run the `/dev-flows:evaluate` skill with the argument `record`: invoke it, don't redo its steps. It reviews the pushed head (only what moved, with `evaluate.scope: delta`), records the verdict, and shows its report. Then run `gate` again, once, and act on what it prints by these same rules, except that a second `stop` with `rerun` stops: `The evaluation of <short sha> wasn't recorded: <its Not recorded reason, else the gate's reason>. Fix that, then re-run /dev-flows:merge.` Nothing has merged.
- `stop` otherwise (a `stop` verdict): stop with its `reason` and the `summary` lines, `Address the evaluation's findings, then re-run /dev-flows:evaluate and /dev-flows:merge.` Nothing has merged.

Merge waits only on the checks the base requires: the `checks` op given `<base>` (the pull request's base branch) says which, and `--required-only` waits on just those (all of them when the op can't say). With `<requireAllChecks>` true, leave `--required-only` off every `ci wait` and `ci record` below: it waits on every check. Checks matching `<ignoreChecks>` aren't waited on either: pass `--ignore-check '<pattern>'` for each, on every `ci wait` and `ci record` below. The host still refuses a merge a required check blocks, so the merge state below stays the authority.

Run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci start --sha <sha>`, then wait for the checks: with a `script` variant of the `checks` op that runs here,

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci wait --sha <sha> --timeout 1800 --required-only [--ignore-check '<pattern>']... --command '<the checks op's script variant, with <sha> and <base> filled in>'
```

It polls every 30 seconds, prints `[ready-ci]` progress to stderr and the final report to stdout. Relay its progress in one line at least once a minute. When the host limits how long one command runs, add `--max-wait <a bit under that limit>` and run it again until it settles; the deadline stays the one `ci start` set. Without a `script` variant, every 30 seconds run the `checks` op for `<sha>` and `<base>`, write its JSON to a file, and run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci record --sha <sha> --file <file> --timeout 1800 --required-only` (with the `--ignore-check` flags), until it says `settled` or `timedOut`.

The report's `noChecks` means nothing it waits on runs on the commit (no CI, or every check reported is optional or ignored): go on. Keep `optional` and `ignored` for the report. `timedOut`: stop with the pull request open, listing `pending`. Settled with `failures` (failed or cancelled checks): with `<requireAllChecks>` true, stop, `<names> failed or were cancelled, and merge.requireAllChecks needs every check to pass. Fix them with /dev-flows:ready, then re-run /dev-flows:merge.` Otherwise go on to the merge state below, which says whether the host needs them; keep their names for the report.

### Review threads

**Skip when `<unresolvedThreads>` is `allow`.** Otherwise the `reviewThreads` op for <N> (for `stack`, for every pull request in the chain). A thread is an automated reviewer's when its first comment's author is a bot, or is a reviewer the repo's agent instructions name as automated. With `bots`, any unresolved automated reviewer's thread stops the merge; with `all`, any unresolved thread does. Stop with each one's `path:line` and author: `#<number> has unresolved review threads, and merge.unresolvedThreads is <value>: <threads>. Address them (/dev-flows:ready fixes an automated reviewer's mechanical ones), then re-run /dev-flows:merge.` People's threads under `bots` don't stop it: list them in the report. An op that fails is a stop too: unread threads aren't no threads.

### Merge state

The `prMergeState` op for <N>:

- `ready`: merge. Failed checks that it lets through are ones the base doesn't require: list them in the report.
- `pending`: wait 3 seconds and ask again, up to 3 times; still pending, stop.
- `blocked`: stop with its reasons. Failed checks: `Fix them with /dev-flows:ready, then re-run /dev-flows:merge.` A review or approval: the people who own it.
- `conflicting` or `behind`: stop, `Run /dev-flows:sync to catch <branch> up to its base, then re-run /dev-flows:merge.` With `<syncMode>` `remote` this is the usual way a branch whose base moved stops: merge leaves the catch-up to sync, so a fresh CI run (and any review) covers it before it lands.

A stop here leaves the pull request open and unmerged. Push nothing from here to the merge.

### Merge one branch

For `branch`: the `prMerge` op with <N>, the method, and `<sha>`. When the host refuses (a moved head, a rule, a method the repository doesn't allow), stop and show its reason as given; for a method it doesn't allow, name the ones to pass instead when it says. Never retry with a bypass.

Then the `prMetadata` op for <N>: its state must be merged. If it isn't, stop: nothing after this runs for an unmerged pull request.

### Merge the chain

For `stack`, instead: the stacking entry's `mergeStack` op. It can take minutes; run it in the foreground. Then the `branchPr` op for every branch in the chain. All merged: go on. Otherwise stop and say plainly that **part of the chain is merged**: list which pull requests merged and which didn't, with the op's output. The usual next step is `/dev-flows:sync` to restack what's left, fix the blocked one, and re-run `/dev-flows:merge`. When it says local branches differ from their remotes, it refused rather than land unpushed work: `/dev-flows:sync`, then re-run.

### Close out

Run the `/dev-flows:sync` skill with the argument `remote` (and `--leave-issue` when `<issueOnMerge>` is `tracker` or `leave`: the tracker moves the issue itself, or nothing does, so sync leaves it as it is). With the pull request merged, it moves the issue to done and resolves the errors the pull request fixed, as far as each integration's `level` allows. A failure here goes in the report; the merge stands.

### Delete the remote branch

Only after the host said merged. When `above` is more than 0, keep it: the pull requests stacked on top target it until they're restacked; say so in the report. Otherwise `git push origin --delete <branch>`; one that says the remote ref doesn't exist was already deleted (the host may do it on merge), which counts as done. Never `git branch -D`, never switch branches, and never remove this worktree: the local branch stays for the user to clean up.

### Watch the deployment

**Only when `<watchDeploy>` is true.** With no deployments entry, say so in the report (`merge.watchDeploy is on, but no deployments integration is configured: run /dev-flows:configure deployments`) and skip this. Otherwise the source-control entry's `mergeCommit` op for <N> (for `stack`, the top of the chain) is `<landed>`; while it's null, ask again every 5 seconds, up to 3 times, then report that the merge commit couldn't be read and skip this.

For each deployments entry, its `deployment` op with `<landed>` as `<sha>`, every 30 seconds for the first 5 minutes and every 60 seconds after, until it's `success` or `failed` or `<deployTimeout>` minutes have gone by. Relay its state and steps in one line at least once a minute. `none` for 5 minutes: that entry deployed nothing for this commit (it may not deploy this branch); say so and stop watching it. Past `<deployTimeout>` minutes: report it still `pending`, with its `url` (`merge.deployTimeout` waits longer).

Read its `steps` by state: `failed` ones are what went wrong; `skipped` ones aren't failures (a deploy skips the parts the commit didn't need, a migration step when nothing changed the schema), so list them apart and never lead with them; `pending` ones at the end are what the timeout cut off.

A failed deployment doesn't undo the merge, and nothing here fixes it: never redeploy, roll back, re-run its workflow, or revert. Lead the report with it, its `url`, and its failed steps. With `<deployLogLines>`, for each failed step with a `log`, the source-control entry's `checkLog` op with that `<log>`, keeping only its last `<deployLogLines>` lines: they go under the step in the report, since a later step can fail after an earlier one already put the new code live, and only the log says how far it got.

## 3. Report

Lead with anything that needs the user's attention: a stop and its reason, a chain that merged partway, failed checks the host let through, a failed close-out, a failed deployment with its failed steps and their log tails. Then:

- **Merged:** the pull request's number and URL; for a chain, every pull request bottom first, the current branch marked.
- **Scope:** `branch` or `stack`, and how it was decided (an argument, the user's answer, or nothing below this branch). Branches still open above this one, and that `/dev-flows:sync` on each restacks them.
- **Method:** the method and why; for a chain, `set by the stacking tool or the host`, and a method argument that wasn't used.
- **CI:** the commit it passed on (short sha), how long it waited, the checks it didn't wait on (not required by the base, or ignored by `ready.ignoreChecks`; with `merge.requireAllChecks`, only the ignored ones), and any failed checks the host didn't require.
- **Sync:** `full` (caught up and pushed, or nothing to do) or `remote` (only the pull request and issue refreshed, from `merge.sync`).
- **Hooks:** what the `beforeCi` hooks committed and pushed, if anything.
- **Evaluation:** with `merge.requireEvaluation`, the verdict it merged on and its commit, whether it carried over from an earlier commit or merge ran evaluate for it, and a flag the user accepted.
- **Close-out:** the issue and its state (or left to the tracker, or as it was, with `merge.issueOnMerge` `tracker` or `leave`), errors resolved, and any to resolve by hand, from the remote sync.
- **Review threads:** with `merge.unresolvedThreads` set, the unresolved threads it checked, and people's threads still open.
- **Remote branch:** deleted, already gone, or kept (and why).
- **Deployment:** with `merge.watchDeploy`, each entry's result for `<landed>` (short sha): `success`, `failed`, still `pending`, or nothing deployed, with its `url` and how long it took; its failed steps (each with its log tail, with `merge.deployLogLines`), then, apart, the steps it skipped, and the ones still pending when the watch timed out.
- **Local:** still on `<branch>`; deleting it and its worktree is the user's call.

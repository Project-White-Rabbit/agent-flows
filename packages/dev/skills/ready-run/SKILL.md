---
name: ready-run
description: Run phase of the /agent-flows:ready flow. Invoked by the ready flow; not run directly
user-invocable: false
---

# /agent-flows:ready: Run

**Mode:** you were dispatched with a mode (`default` or `loop` or `draft`); which steps apply and where they route below depend on it.

**Run only when mode is `default`, `loop` or `draft`.**

## 1. Sync (local pass)

Run the `/agent-flows:sync` skill with the argument `local`: invoke it, don't redo its steps. It commits pending work (the cleanup included), catches up to the base, and leaves the branch ahead of its remote; `local` never pushes, opens a pull request, or touches the issue. The publish step owns the push.

When sync stops (a conflict it needs you for, a hook it couldn't satisfy), stop too and pass its message on.

**No-op rule.** When sync has nothing to commit or catch up, carry on: an existing pull request can still need marking ready, its body refreshed, review threads addressed, or CI fixed. Stop only when there's no pull request and nothing ahead of the base: there's no work to publish.

## 2. Publish

The source-control and stacking entries, `<base>`, and `<parent>` are from 1a of the *Local cleanup* section of the `ready` skill. Re-run `currentPr`: sync may have changed things.

### Push

Skip the push when the branch's remote has this exact commit: `git fetch origin <branch>` and `git rev-parse HEAD` equals `git rev-parse origin/<branch>`.

- **With a stacking integration:** its `submit` op. It pushes and opens the pull request as a draft when there's none, and leaves an existing one's title, body, and draft or ready state alone. When it says the branch isn't tracked, run its `track` op with `<parent>`, then `submit` again.
- **Without one:** `git push -u origin HEAD`. If it's rejected because the remote branch moved, `git fetch origin <branch>`, `git merge --no-edit origin/<branch>`, resolve as sync does, and push again. Never force.

### Pull request

When there's still none (no stacking integration, or one whose `submit` didn't open it): the `prCreate` op with `<base>` `<parent>`, a title in the repo's convention (its agent instructions, then the shape of recent subjects on the base, `git log -20 --format=%s <parent>`), and an empty body file. The remote sync below writes the body; anything put there now would survive it as text outside sync's block. Quote the title for the shell: single quotes, with any `'` written as `'\''`.

Then the `prMergeability` op: `pending` → wait 3 seconds and ask again, up to 3 times, then treat it as clean; `conflicting` or `behind` → run the `/agent-flows:sync` skill with `local` once more, push again, and ask again. Still not clean: stop and show the user what the op returned.

### Mark ready

**Skip in `draft` mode**: the pull request stays a draft. Otherwise, when `currentPr` says it's a draft, the `prReady` op. Already ready: nothing to do; note it for the report.

### Start the CI pass

`<sha>` is `git rev-parse HEAD`, the commit just published. Run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci start --sha <sha>`: it starts this commit's pass (its 15-minute clock, and the record later snapshots are compared against). Print `Ready CI pass <pass>: waiting up to 15 minutes for <short sha>.`

When the `checks` op has a `script` variant that runs here, start the waiter now, in the background if this host can run a command in the background, so the remote sync overlaps the wait:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci wait --sha <sha> --command '<the checks op's script variant, with <sha> filled in>'
```

It polls every 30 seconds until every check settles or the pass times out, prints `[ready-ci]` progress and each new failure to stderr, and the final report to stdout. Read its progress at least once a minute and relay it in one line. Keep its handle: the CI step joins it, and never starts a second waiter for the same commit. Pinning it to the local `<sha>` keeps a lagging pull request head from making it watch the previous commit. When the host limits how long one command runs, add `--max-wait <a bit under that limit>` and run it again until it settles: the pass's clock started at `ci start`, so a rerun keeps the same deadline.

## 3. Sync (remote pass)

Run the `/agent-flows:sync` skill with the argument `remote`. It refreshes everything outside the git tree against the published state: the pull request's body and title, the issue's description and Status, and the issue's state, which follows the pull request (now `in review` once it's ready; still `in progress` in `draft` mode). It never commits, pushes, or creates a pull request, so the push above has to come first.

Run it even when the local sync and the publish changed nothing: an already-published pull request can still need its links or issue state refreshed. When it fails, say so in the report and carry on to CI: the remote sync can be re-run on its own.

## 4. CI

Read every check and the automated reviewers' threads, fix what's high-confidence, push, and in `loop` mode repeat. **Every fix must be high-confidence; if it isn't, stop and ask.** High-confidence: a lint, format, or type error with one obvious fix; a test that fails because the test itself is out of date with a change the branch meant to make; a version bump or changelog entry a check requires, made with the repo's own command for it, at the smallest level; generated files regenerated with the repo's command; an automated reviewer's suggestion that is mechanical and unambiguous (a rename, a null check, a missing `await`). Stop and ask when: a test fails for a reason that needs a change to source logic; a type error means a real API change; a review comment needs a judgment call (architecture, scope, behavior); the same failure survives a fix attempt; the failure is in infrastructure, is flaky, or is in code the branch doesn't touch; a version bump past the smallest level looks warranted; it involves a database migration or a dependency or toolchain version; anything unfamiliar. The bar: if you'd write a comment apologizing for a wrong guess, don't make the guess. Hand it back.

**Settled** means every check has reached `pass`, `skipping`, `fail`, or `cancelled`; a `pending` check isn't settled, and CI is green only once every check settled with none failed. In `loop` mode, prepare fixes for visible failures while other checks still run, but **never commit or push until the commit's checks have all settled**: that keeps the rest of the run's signal and puts every fix from it in one push. A pass waits at most 15 minutes; past that, list what's still pending (`Timed out waiting for checks to settle (15m). Still pending: <names>. These may need manual inspection.`) and exit without pushing partial fixes.

### Wait for the checks

Join the waiter the publish step started. When there's none (the op has no `script` variant that runs here, or its handle was lost), wait in the foreground: with a `script` variant, `ci wait` as in the publish step; without one, every 30 seconds run the `checks` op for `<sha>`, write its JSON (in the shape the op describes) to a file, and run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci record --sha <sha> --file <file>`, until it says `settled` or `timedOut`. Never poll with a second waiter for the same commit.

Each report has `settled`, `timedOut`, `green`, `noChecks`, `counts`, `pending`, `failures` (each with its `name`, `state`, `link`, and `log`), `newFailures` (not reported before in this pass), and `stalled`. Use them as given: the last report once settled is the authority for this pass.

- `noChecks`: nothing reported on the commit within 3 minutes, so the repo runs no CI on it. Say so in the report and skip to the review threads.
- `timedOut`: list `pending` and stop as above.
- `stalled` not empty: checks a fix was pushed for failed again. The fix didn't work: stop and hand them to the user with their logs. Don't push again.

In `loop` mode, act on each `newFailures` entry as it arrives (from the waiter's `[ready-ci]` lines or a record): read its log, categorize it, and prepare a high-confidence fix **locally only**.

### Read the failures

For each failure with a `log`, the `checkLog` op with `<log>`; read logs for failures visible at the same time in parallel, but edit files one at a time. A failure with no `log` is an outside service's status: its `link` is all there is, so name it in the report rather than guess at it.

Then the `reviewThreads` op for the pull request. A thread is an **automated reviewer's** when its first comment's author is a bot, or is a reviewer the repo's agent instructions name as automated. Read only those threads' comments; leave people's threads to the people (count them for the report). Do this once per settled pass, not on every poll.

### Categorize

| Bucket | Trigger | What to do |
|---|---|---|
| **Local check miss** | A lint, format, type, test, or build check fails on code the branch touched | Reproduce the one failing check or test file locally with the command chosen in 1d of the *Local cleanup* section of the `ready` skill, fix it, and keep it local until the batch push. Run the cleanup again only when the failure shows its scope missed something |
| **Required bookkeeping** | A check says a version bump, changelog entry, or regenerated file is missing | Make it with the repo's own command, at the smallest level. A bigger bump looks warranted: stop |
| **Automated review** | An unresolved thread from an automated reviewer | A mechanical, unambiguous suggestion: apply it, and resolve the thread after the push. A judgment call: stop |
| **Migration or schema** | A check finds a schema change with no migration, or a migration problem | Stop: migrations need the user's approval |
| **Dependency or toolchain version** | A check wants a dependency, runtime, or tool version moved or aligned | Stop: that's the team's decision |
| **Cancelled** | A check ended `cancelled` | Stop: don't read a cancellation as a pass |
| **Not the branch's** | Infrastructure, a flaky test, a timeout, or a failure in code the branch doesn't touch | Stop, with the check's name and log tail |
| **Other** | Anything else | Only a non-controversial fix (mechanical, one obvious correction, no source-logic judgment, no new dependency, no scope or infrastructure change). Otherwise stop, with the check's name and log tail |

On a **stop** bucket, don't attempt the uncertain fix and don't push any partial fix. In `loop` mode before the commit settles, note the blocker and keep waiting, so the report has every failure from that commit; surface them all together once it settles.

### Fix and push

Apply the high-confidence fixes in this order, so later ones build on earlier ones: local check misses, then required bookkeeping, then automated review suggestions. After each bucket, `git status --short` must show a change; a fix that produced no diff is a stalled fix: stop and surface it.

Once the commit's checks have all settled, with no stop bucket and at least one fix, commit them in one batch: `git add -A`, then `git commit -m "<message>"` in the repo's convention (`CI: address review comments`, say). Push as the publish step does: the stacking entry's `submit`, else `git push origin HEAD`. The push leaves the pull request's draft or ready state alone. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci start --sha <the new HEAD> --fixed <check name>...
```

with a `--fixed` for each failed check the batch meant to fix, so the next pass can tell a fix that didn't work.

**Resolve review threads** only after that push succeeds: for each automated reviewer's thread whose fix is now on the remote, the `resolveThread` op. A thread whose fix stayed local (a stop, a failed commit or push) stays unresolved, so the host never claims an unshipped fix. Never resolve a person's thread. A resolve that fails gets a one-line warning, not a stop.

### Loop or exit

- **`default` and `draft` mode:** one pass. Go to the report; don't wait for the run the fix push started.
- **`loop` mode:** a stop bucket or a stalled fix ends it: report the blockers and exit without pushing. A fix push starts the next pass: print `Ready CI pass <pass>: waiting up to 15 minutes for <short sha>.`, start one waiter for the new commit as the publish step does, and come back to *Wait for the checks*. A pass that settled green, with no automated reviewer's thread left unresolved, ends it successfully. Report success only for a commit you saw go green; never because a number of passes or minutes went by.

`loop` mode is a long-running foreground task by design: the user asked you to sit on it. Run the waiter in the background only so you can keep fixing while it waits, never to end your turn and come back later.

## 5. Report

Lead with anything that needs the user's attention: every stop bucket and stalled fix with the check's name and log tail, what you would have done and why you didn't, a failed remote sync, a timeout. Don't bury it under the rest. Then:

- **Mode** that ran (`default`, `loop`, or `draft`).
- **Local cleanup:** clean, fixed N things (what changed together, tests written, check fixes), or surfaced N for the user; the packages checked and with which commands.
- **Sync (local):** committed, caught up (and any conflicts resolved, by file), or nothing to do.
- **Publish:** pushed or already published; pull request opened or existing; marked ready, already ready, or left a draft in `draft` mode; its mergeability.
- **Sync (remote):** the pull request and issue URLs, and the issue's state.
- **CI:** in `loop` mode, the passes it waited on, the fix pushes, the final state of the checks, and which exit it took; otherwise, what the one pass fixed and pushed, and what's left for the next run. Pass and fail counts for the last settled commit.
- **Review threads:** `Automated review: N open / M resolved this run`, always, even when both are 0, and the number of people's threads still open.

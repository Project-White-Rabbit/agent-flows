---
name: ready-run
description: Run phase of the /dev-flows:ready flow. Invoked by the ready flow; not run directly
user-invocable: false
---

# /dev-flows:ready: Run

**Mode:** you were dispatched with a mode (`default` or `loop` or `draft`); which steps apply and where they route below depend on it.

**Run only when mode is `default`, `loop` or `draft`.**

## 1. Sync (local pass)

Run the `/dev-flows:sync` skill with the argument `local`: invoke it, don't redo its steps. It commits pending work (the cleanup included), catches up to the base, and leaves the branch ahead of its remote; `local` never pushes, opens a pull request, or touches the issue. The publish step owns the push.

When sync stops (a conflict it needs you for, a hook it couldn't satisfy), stop too and pass its message on.

**No-op rule.** When sync has nothing to commit or catch up, carry on: an existing pull request can still need marking ready, its body refreshed, review threads addressed, or CI fixed. Stop only when there's no pull request and nothing ahead of the base: there's no work to publish.

## 2. Publish

The source-control and stacking entries, `<base>`, `<parent>`, `<mergeBase>`, and `<ciTimeout>` are from 1a of the *Local cleanup* section of the `ready` skill. Re-run `currentPr`: sync may have changed things.

### Before pushing

`node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run ready.beforePush --flow ready --mode <mode> --base <mergeBase>`, whatever `skip` says. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop. They see the commits sync just made. When they changed files, commit them (`git add -A`, then a message in the repo's convention) before the push, so the commit they checked is the one published.

### Push

Skip the push when the branch's remote has this exact commit: `git fetch origin <branch>` and `git rev-parse HEAD` equals `git rev-parse origin/<branch>`.

- **With a stacking integration:** its `submit` op. It pushes and opens the pull request as a draft when there's none, and leaves an existing one's title, body, and draft or ready state alone. When it says the branch isn't tracked, run its `track` op with `<parent>`, then `submit` again. When it fails for another reason than a conflict (the tool's own API or sign-in), push anyway with `git push --force-with-lease -u origin HEAD` (the stacking tool rebased the branch, and the lease refuses to overwrite work pushed since the last fetch), and say so in the report. Keep the stacking tool's URL for the pull request when it prints one.
- **Without one:** `git push -u origin HEAD`. If it's rejected because the remote branch moved, `git fetch origin <branch>`, `git merge --no-edit origin/<branch>`, resolve as sync does, and push again. Never force.

### Pull request

When there's still none (no stacking integration, or one whose `submit` didn't open it): the `prCreate` op with `<base>` `<parent>`, a title in the repo's convention (its agent instructions, then the shape of recent subjects on the base, `git log -20 --format=%s <parent>`), and an empty body file. The remote sync below writes the body; anything put there now would survive it as text outside sync's block. Quote the title for the shell: single quotes, with any `'` written as `'\''`.

Then the `prMergeability` op: `pending` → wait 3 seconds and ask again, up to 3 times, then treat it as clean; `conflicting` or `behind` → run the `/dev-flows:sync` skill with `local` once more, push again, and ask again. Still not clean: stop and show the user what the op returned.

### Mark ready

**Skip in `draft` mode**: the pull request stays a draft. Otherwise, when `currentPr` says it's a draft, the `prReady` op. Already ready: nothing to do; note it for the report.

### Start the CI pass

**Skip when `skip` has `ci`:** no pass, no waiter.

`<sha>` is `git rev-parse HEAD`, the commit just published. Run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci start --sha <sha> --first`: it starts this run's first pass (its `<ciTimeout>`-minute clock, and the record later snapshots are compared against). Print `Ready CI pass <pass>: waiting up to <ciTimeout> minutes for <short sha>.`

When the `checks` op has a `script` variant that runs here, start the waiter now, in the background if this host can run a command in the background, so the remote sync overlaps the wait:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci wait --sha <sha> --command '<the checks op's script variant, with <sha> filled in and <parent> as <base>>' [--ignore-check '<pattern>']...
```

with an `--ignore-check` for each entry of `ignoreChecks` from 1a of the *Local cleanup* section of the `ready` skill. Giving the `checks` op the pull request's base (`<parent>`) has it mark the checks merging there requires and list a required one that hasn't reported yet as pending, so a quick check settling first can't read as the whole run; ready still waits on every check. It polls every 30 seconds until every check settles or the pass times out, prints `[ready-ci]` progress and each new failure to stderr, and the final report to stdout. Read its progress at least once a minute and relay it in one line. Keep its handle: the CI step joins it, and never starts a second waiter for the same commit. Pinning it to the local `<sha>` keeps a lagging pull request head from making it watch the previous commit. When the host limits how long one command runs, add `--max-wait <a bit under that limit>` and run it again until it settles: the pass's clock started at `ci start`, so a rerun keeps the same deadline.

### Request the code review

**Only with `<reviewers>`** from 1a of the *Local cleanup* section of the `ready` skill. For each, its `requestReview` op with the pull request's number as `<pr>` and `git rev-parse HEAD` as `<sha>`. Keep its `requested` as `<requested>` and its `url`; the CI step reads the review. Request once per run: the CI step's fix pushes never request another, since each one is a new paid run. A request that fails gets a one-line warning in the report, not a stop.

## 3. Sync (remote pass)

Run the `/dev-flows:sync` skill with the argument `remote`. It refreshes everything outside the git tree against the published state: the pull request's body and title, the issue's description and Status, and the issue's state, which follows the pull request (now `in review` once it's ready; still `in progress` in `draft` mode). It never commits, pushes, or creates a pull request, so the push above has to come first.

Run it even when the local sync and the publish changed nothing: an already-published pull request can still need its links or issue state refreshed. When it fails, say so in the report and carry on to CI: the remote sync can be re-run on its own.

## 4. CI

Read every check and the automated reviewers' threads, fix what's high-confidence, push, and in `loop` mode repeat. **Every fix must be high-confidence; if it isn't, stop and ask.** High-confidence: a lint, format, or type error with one obvious fix; a test that fails because the test itself is out of date with a change the branch meant to make; a version bump or changelog entry a check requires, made with the repo's own command for it, at the smallest level; generated files regenerated with the repo's command; an automated reviewer's suggestion that is mechanical and unambiguous (a rename, a null check, a missing `await`). Stop and ask when: a test fails for a reason that needs a change to source logic; a type error means a real API change; a review comment needs a judgment call (architecture, scope, behavior); the same failure survives a fix attempt; the failure is in infrastructure, is flaky, or is in code the branch doesn't touch; a version bump past the smallest level looks warranted; it involves a database migration or a dependency or toolchain version; anything unfamiliar. The bar: if you'd write a comment apologizing for a wrong guess, don't make the guess. Hand it back.

**Skips** (`skip` and `ignoreChecks` from 1a of the *Local cleanup* section of the `ready` skill):

- `ci`: don't wait for the checks, read their logs, or fix them. With `reviews` too, skip this step and go to the report. Otherwise handle only the automated reviewers' threads and the requested reviews, once: wait for the reviews as below, read them, fix and push as below (with no `ci start` after the push), resolve what shipped, and go to the report. `loop` mode has no run to watch, so it makes this one pass.
- `reviews`: don't read, fix, or resolve review threads, and a green pass doesn't wait on them (no review was requested either).
- `ignoreChecks`: pass an `--ignore-check` for each to every `ci wait` and `ci record`. Those checks aren't waited on, counted, or failed; the report lists them as `ignored`. Never fix an ignored check, even when its failure is plain.

**Settled** means every check has reached `pass`, `skipping`, `fail`, or `cancelled`; a `pending` check isn't settled, and CI is green only once every check settled with none failed. In `loop` mode, prepare fixes for visible failures while other checks still run, but **never commit or push until the commit's checks have all settled**: that keeps the rest of the run's signal and puts every fix from it in one push. A pass waits at most `<ciTimeout>` minutes (1a of the *Local cleanup* section of the `ready` skill); past that, list what's still pending (`Timed out waiting for checks to settle (<ciTimeout>m). Still pending: <names>. These may need manual inspection.`) and exit without pushing partial fixes. A report's `missing` lists required checks that haven't reported at all: they're pending too. With `ready.settleGrace`, a set with nothing pending is `settling` until it has held still that long, so a check that registers late still counts.

### Wait for the checks

Join the waiter the publish step started. When there's none (the op has no `script` variant that runs here, or its handle was lost), wait in the foreground: with a `script` variant, `ci wait` as in the publish step; without one, every 30 seconds run the `checks` op for `<sha>` and `<parent>` as `<base>`, write its JSON (in the shape the op describes) to a file, and run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci record --sha <sha> --file <file>` (with the `--ignore-check` flags), until it says `settled` or `timedOut`. Never poll with a second waiter for the same commit.

Each report has `settled`, `timedOut`, `green`, `noChecks`, `counts`, `pending`, `failures` (each with its `name`, `state`, `link`, `log`, and `codeScanning` for a code-scanning check), `newFailures` (not reported before in this pass), `stalled`, `noProgress`, `rollupFailures` (failed checks in `ready.rollupChecks`, which only gather the others), `ignored` (checks left out by `ignoreChecks`), `missing` (required checks not reported yet, counted as pending), `settling`, and `awaitingChecks`. Use them as given: the last report once settled is the authority for this pass.

- `noChecks`: nothing reported on the commit within 3 minutes, so the repo runs no CI on it, or every check reported is ignored. Say which in the report and skip to the review threads.
- `timedOut`: list `pending` and stop as above. With `awaitingChecks` true, nothing reported at all, and `ready.requireChecks` says every commit runs CI: stop, `No CI check reported on <short sha> within <ciTimeout> minutes, and ready.requireChecks needs one to. Check that CI ran on the commit.`
- `stalled` not empty: checks a fix was pushed for failed again. The fix didn't work: stop and hand them to the user with their logs. Don't push again.
- `noProgress`: this run's previous pass settled with failures, and every one of them failed again, so nothing the last push did turned a check green. Stop and hand the failures to the user, as for `stalled`. Don't push again.

In `loop` mode, act on each `newFailures` entry as it arrives (from the waiter's `[ready-ci]` lines or a record): read its log, categorize it, and prepare a high-confidence fix **locally only**.

### Read the failures

For each failure with a `log`, the `checkLog` op with `<log>`; read logs for failures visible at the same time in parallel, but edit files one at a time. A failure with `codeScanning` (CodeQL and other static analysis) has no log: its findings are the `codeScanningAlerts` op's for the pull request, read in its place, each alert's `rule`, `path:line`, and `message` standing for the log's error. Any other failure with no `log` is an outside service's status: its `link` is all there is, so name it in the report rather than guess at it.

**Rollups:** never fix a check in `rollupFailures`, or read it as a failure of its own: it only reports the others' results. Work the failing checks it gathers instead, and leave it out of `--fixed`. When it's the only failure (what it gathers isn't on the commit, or passed), stop and name it with its `link`: whatever failed under it is out of ready's sight.

Then, unless `skip` has `reviews`, the `reviewThreads` op for the pull request. A thread is an **automated reviewer's** when its first comment's author is a bot, or is a reviewer the repo's agent instructions name as automated. Read only those threads' comments; leave people's threads to the people (count them for the report). Do this once per settled pass, not on every poll.

**Requested reviews**, for each review the publish step requested that no pass has read yet (in `loop` mode, one still running carries over to the next pass): its `reviewResult` op with `<pr>` and `<requested>`. While it's `pending`, ask again every 30 seconds alongside the checks, until it's `done`, `failed`, `missing`, or `skipped`, or the pass's `<ciTimeout>` minutes run out; then it's still running: give its `run` in the report, and don't hold the pass for it. `failed`, `missing`, and `skipped` go in the report with the run (`missing`: no run picked the request up, so check the workflow's trigger; `skipped`: the workflow woke for it, and its condition turned the request away, so check the mention it matches); none is a stop. A `note` (the run matched only loosely) goes in the report too. On `done`, read its `findings`: each is a comment or review summary that may hold several points, so take them one point at a time. Its inline comments are threads by a bot, already read with the threads above.

### Categorize

| Bucket | Trigger | What to do |
|---|---|---|
| **Local check miss** | A lint, format, type, test, or build check fails on code the branch touched | Reproduce the one failing check or test file locally with the command chosen in 1d of the *Local cleanup* section of the `ready` skill, fix it, and keep it local until the batch push. Run the cleanup again only when the failure shows its scope missed something |
| **Required bookkeeping** | A check says a version bump, changelog entry, or regenerated file is missing | Make it with the repo's own command, at the smallest level. A bigger bump looks warranted: stop |
| **Automated review** | An unresolved thread from an automated reviewer, or a point in a requested review's findings | A mechanical, unambiguous suggestion: apply it, and resolve the thread after the push (a finding in a comment has no thread to resolve: the report lists it as fixed). A judgment call, or a point that's only an observation: hand it back, without stopping the other fixes |
| **Code scanning** | An open alert on a failed `codeScanning` check | A mechanical alert with one obvious, behavior-preserving fix on code the branch touched (an unused variable or import, a missing `await`): fix it like a local check miss. Anything that takes security judgment (an injection, an auth or permission check, crypto, secrets, data exposure, a sanitizer) or a dismissal: stop, with the alert's `url` |
| **Migration or schema** | A check finds a schema change with no migration, or a migration problem | Stop: migrations need the user's approval |
| **Dependency or toolchain version** | A check wants a dependency, runtime, or tool version moved or aligned | Stop: that's the team's decision |
| **Cancelled** | A check ended `cancelled` | Stop: don't read a cancellation as a pass |
| **Not the branch's** | Infrastructure, a flaky test, a timeout, or a failure in code the branch doesn't touch | Stop, with the check's name and log tail |
| **Other** | Anything else | Only a non-controversial fix (mechanical, one obvious correction, no source-logic judgment, no new dependency, no scope or infrastructure change). Otherwise stop, with the check's name and log tail |

On a **stop** bucket, don't attempt the uncertain fix and don't push any partial fix. In `loop` mode before the commit settles, note the blocker and keep waiting, so the report has every failure from that commit; surface them all together once it settles.

### Fix and push

Apply the high-confidence fixes in this order, so later ones build on earlier ones: local check misses, then required bookkeeping, then automated review suggestions. After each bucket, `git status --short` must show a change; a fix that produced no diff is a stalled fix: stop and surface it.

Once the commit's checks have all settled, with no stop bucket and at least one fix, **rerun the local checks** on the batch before committing it, so a fix push never trades one failure for another: the fix commands, then the check commands, chosen as in 1d of the *Local cleanup* section of the `ready` skill (the config's `commands`, else the touched packages' scripts with the relevant tests), run and capped the same way, minus what `skip` turns off there (`fix`, `checks`). Rerun them for every package the branch touches, not only the ones the fixes did. A failure the batch caused gets a high-confidence fix and another rerun; one it didn't cause, or one that survives a fix, is a stop: report it and don't push. Then commit them in one batch: `git add -A`, then `git commit -m "<message>"` in the repo's convention (`CI: address review comments`, say). Push as the publish step does: the stacking entry's `submit`, else `git push origin HEAD`. The push leaves the pull request's draft or ready state alone. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" ci start --sha <the new HEAD> --fixed <check name>...
```

with a `--fixed` for each failed check the batch meant to fix, so the next pass can tell a fix that didn't work. When the config sets `maxPasses`, its output has `capped`: true means this is the run's last pass.

**Resolve review threads** only after that push succeeds: for each automated reviewer's thread whose fix is now on the remote, the `resolveThread` op. A thread whose fix stayed local (a stop, a failed commit or push) stays unresolved, so the host never claims an unshipped fix. Never resolve a person's thread. A resolve that fails gets a one-line warning, not a stop.

### Loop or exit

- **`default` and `draft` mode:** one pass. Go to the report; don't wait for the run the fix push started.
- **`loop` mode:** a stop bucket, a stalled fix, or `noProgress` ends it: report the blockers and exit without pushing. A fix push starts the next pass: print `Ready CI pass <pass>: waiting up to <ciTimeout> minutes for <short sha>.`, start one waiter for the new commit as the publish step does, and come back to *Wait for the checks*. A pass that settled green, with no automated reviewer's thread left unresolved and every requested review read (unless `skip` has `reviews`), ends it successfully. On a pass `ci start` said was `capped`, wait for it to settle and read it, but don't fix or push again: when it isn't green, report `Stopped at the pass cap (<maxPasses>)` with what's still failing. Report success only for a commit you saw go green; never because a number of passes or minutes went by.

`loop` mode is a long-running foreground task by design: the user asked you to sit on it. Run the waiter in the background only so you can keep fixing while it waits, never to end your turn and come back later.

## 5. Report

Lead with anything that needs the user's attention: every stop bucket and stalled fix with the check's name and log tail, what you would have done and why you didn't, a failed remote sync, a timeout. Don't bury it under the rest. Then:

- **Mode** that ran (`default`, `loop`, or `draft`), the steps it skipped, and the CI check patterns it ignored, each with where it came from (the config or a flag).
- **Local cleanup:** clean, fixed N things (what changed together, tests written, check fixes), or surfaced N for the user; the packages checked and with which commands.
- **Sync (local):** committed, caught up (and any conflicts resolved, by file), or nothing to do.
- **Publish:** pushed or already published (and a `submit` that failed, with the push it fell back to); pull request opened or existing, with its URL in the stacking tool's app when `submit` printed one; marked ready, already ready, or left a draft in `draft` mode; its mergeability.
- **Sync (remote):** the pull request and issue URLs, the issue's state, and whether sync created the issue (and as a sub-issue of which) or updated an existing one, from its report.
- **CI:** in `loop` mode, the passes it waited on, the fix pushes, the final state of the checks, and which exit it took; otherwise, what the one pass fixed and pushed, and what's left for the next run. Pass and fail counts for the last settled commit, and the checks it ignored. With `ci` skipped: `CI: skipped`.
- **Review threads:** `Automated review: N open / M resolved this run`, always, even when both are 0, then one line per automated reviewer with threads on the pull request, named by its first comment's author (a bug-finding bot, say): `<reviewer>: N open / M resolved`. Then the number of people's threads still open. With `reviews` skipped: `Automated review: skipped`.
- **Code review:** for each requested review, `Code review (<entry>) on <short sha>: <state>`, with its run's link and its `note` (for `skipped`, say the workflow turned the request away, and to check the mention it matches); on `done`, the number of points it raised, fixed, and handed back (each handed-back point in a line, with its link), and its inline threads. None requested: `Code review: not requested`, and why when a reviewer is configured (its level is `request` and there was no `--review`, `--no-review`, or `reviews` skipped). A request that failed: its warning.

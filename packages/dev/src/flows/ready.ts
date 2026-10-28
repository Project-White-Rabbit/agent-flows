import type { Flow } from "@agent-flows/core"
import {
  CONFIGURE_GET_AND_INTEGRATIONS,
  DEV_COMMANDS,
  devKit,
  HOOK_RESULTS,
  HOOKS_COMMAND,
  hooksInvariant,
  REQUIRE_CONFIG,
  STACK_PARENT,
  UNKNOWN_FLAGS,
  USE_INTEGRATIONS,
} from "./kit.ts"

// How a check's output stays out of context: everything to a log, and only
// warnings, errors, and the summary back, or the tail when it fails.
const CAPPED = `(<command>) > <logDir>/<package>-<step>.log 2>&1 && { grep -iE "(warning|error)" <logDir>/<package>-<step>.log | head -20; tail -10 <logDir>/<package>-<step>.log; } || tail -200 <logDir>/<package>-<step>.log`

// The bar every automatic fix clears, said once and pointed to from each step.
const CONFIDENCE =
  "**Every fix must be high-confidence; if it isn't, stop and ask.** High-confidence: a lint, format, or type error with one obvious fix; a test that fails because the test itself is out of date with a change the branch meant to make; a version bump or changelog entry a check requires, made with the repo's own command for it, at the smallest level; generated files regenerated with the repo's command; an automated reviewer's suggestion that is mechanical and unambiguous (a rename, a null check, a missing `await`). Stop and ask when: a test fails for a reason that needs a change to source logic; a type error means a real API change; a review comment needs a judgment call (architecture, scope, behavior); the same failure survives a fix attempt; the failure is in infrastructure, is flaky, or is in code the branch doesn't touch; a version bump past the smallest level looks warranted; it involves a database migration or a dependency or toolchain version; anything unfamiliar. The bar: if you'd write a comment apologizing for a wrong guess, don't make the guess. Hand it back."

export const readyFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "ready",
  title: "{{cmd}}ready",
  frontmatter: {
    description:
      "Take finished branch work to a ready, green pull request: scoped local cleanup and checks, commit, publish, mark it ready, and fix CI with high confidence. Not for merging, reviewing, or one-off checks.",
    argumentHint: {
      deriveFromModes: true,
      suffix: "[--skip <steps>] [--ignore-check <pattern>]...",
    },
  },
  commands: DEV_COMMANDS.defineCommands({
    hooks: HOOKS_COMMAND,
    configure: CONFIGURE_GET_AND_INTEGRATIONS,
    ready: {
      description:
        "`plan` scopes the branch (merge base, changed files, touched packages and their check scripts, agent instructions, the config's ready commands, and the steps to skip and CI checks to ignore); `ci start`, `ci record`, and `ci wait` track each pushed commit's CI pass: settled, timed out, new failures, and fixes that didn't work",
      args: "<subcommand>",
    },
  }),
  tools: {},
  compile: {
    // Help and the local cleanup stay inline; publishing and the CI pass
    // load only once the branch is clean.
    mode: { default: "split-chain" },
    inlinePhases: ["main"],
  },
  entries: {
    default: "main/prepare",
    loop: "main/prepare",
    draft: "main/prepare",
    help: "main/help",
  },
  defaultMode: "default",
  modeHints: {
    default:
      "Run the full pipeline: local cleanup, sync local, publish and mark the PR ready, sync remote, then one CI fix pass.",
    loop: "Same pipeline, then babysit CI until every check is green or progress stalls.",
    draft:
      "Same pipeline, but leave the PR a draft: everything except marking it ready.",
    help: "Show usage and exit without running the pipeline.",
  },
  intro:
    "Take a branch from \"I think I'm done\" to \"this pull request is ready and green.\" It bundles scoped local cleanup (what must change together, tests, the repo's own fix and check commands for what the branch touches), `{{cmd}}sync local`, the push and the draft-to-ready flip, `{{cmd}}sync remote`, and a CI fix pass into one command. Local checks cover what the branch touches; CI stays the full-suite backstop. The two sync calls bookend the publish on purpose: `local` commits the cleanup without touching anything remote, publish pushes and marks the pull request ready in one beat, and `remote` refreshes the pull request body and its issue against the published state (so the issue moves to in review). Every vendor-specific action goes through the repo's configured integrations (`{{cmd}}configure`), so the same skill works with any source-control host and CI, with or without a stacking tool. Any step can be skipped, and any CI check ignored, from the config's `ready` section or for one run with `--skip` and `--ignore-check`.",
  invariants: [
    `This command fixes CI failures itself. ${CONFIDENCE}`,
    "**Act through the integrations' ops.** Pull requests, checks, logs, review threads, and stacks are reached only through the ops `configure.ts integrations` returns, run as given. Plain `git` is fine for everything local.",
    "**Sync owns the pull request's body and the issue.** Ready never writes either; it runs `{{cmd}}sync` for them.",
    "**Never rewrite pushed history yourself, and never force-push.** Without a stacking integration, catch up by merging; with one, its `restack` and `submit` ops own the rebase and the push.",
    "**Never use destructive escapes** (`git reset --hard`, `git rebase --abort`, `git stash`, `git push --force` without `--force-with-lease`) to get out of a conflict.",
    "**Never run a command with side effects outside the checkout** to check the branch: nothing that deploys, publishes, migrates or writes to a database, or calls a shared service. Read a script before running it when its name doesn't make that plain.",
    "**Never create, edit, or apply a database migration, and never move a dependency or toolchain version** to make a check pass. Those are the team's decisions: surface them.",
    "**Only change tests when fixing a failing test**, never source. A test that shows a source bug is the user's to look at.",
    hooksInvariant("ready", { afterPoint: true, extra: "--base <mergeBase>" }),
  ],
  phases: [
    {
      id: "main",
      title: "Local cleanup",
      stepStyle: "headers",
      steps: [
        {
          id: "help",
          kind: "action",
          title: "Help shortcut",
          preamble: true,
          body: `If mode is \`help\`, print the block below verbatim and exit. No reads, no writes.

\`\`\`
{{cmd}}ready  [loop | draft | help] [--skip <steps>] [--ignore-check <pattern>]...

Modes:
  default  One full pass: local cleanup, sync local, publish (push and
           mark ready), sync remote, one CI fix pass. Doesn't wait for
           the run its fixes start.
  loop     Default, then: fix failures locally as they appear, wait for
           the run to settle, rerun the local checks, push all fixes at
           once, and repeat until green or progress stalls.
  draft    Leaves the pull request a draft. Everything else still runs.
  help     Show this and exit.

Flags:
  --skip <steps>            Skip steps for this run, comma-separated:
                            cleanup, tests, fix, checks, local (those
                            four), ci, reviews, all (every step: only
                            commit, publish, and sync)
  --ignore-check <pattern>  Don't wait on or fix CI checks whose name
                            matches (* is any run of characters).
                            Repeatable

Steps (all modes):
  1. Local cleanup: scope the branch, update what must change with it
     (cleanup) and its tests (tests), then the repo's fix and check
     commands for what it touches (fix, checks)
  2. {{cmd}}sync local: commit and catch up to the base, no push
  3. Publish: push, open the pull request if there's none, mark it
     ready (not in draft)
  4. {{cmd}}sync remote: refresh the pull request body and its issue
  5. CI: wait for the checks (ci), and read automated reviewers'
     threads (reviews); fix what's high-confidence, push once

It uses the integrations in .agent-flows/config.json: source control
for the pull request, its checks, and its review threads (at write
level), and a stacking tool when there is one. The config's \`ready\`
section can name the fix and check commands; otherwise it runs the
scripts of each package the branch touches, as the repo's agent
instructions say. Its \`skip\` and \`ignoreChecks\` lists apply to every
run; the flags add to them. Its \`before\`, \`beforePublish\`, and
\`after\` hooks, and the general ones in the \`hooks\` section, run
whatever is skipped.
\`\`\``,
          next: null,
        },
        {
          id: "prepare",
          kind: "action",
          title: "Local cleanup",
          refName: "local cleanup",
          commandCalls: ["configure", "hooks", "ready"],
          body: `Parse the argument for a mode keyword (\`loop\`, \`draft\`, \`help\`). No keyword means default mode.

**Flags:** take \`--skip <steps>\` (comma-separated, may repeat) and \`--ignore-check <pattern>\` (may repeat) out of the arguments, for the plan below. ${UNKNOWN_FLAGS} Read plain words the same way: "don't write tests" is \`--skip tests\`; "skip the local checks" is \`--skip local\`; "don't wait for CI" or "just push it" is \`--skip ci\`; "ignore the review bots" is \`--skip reviews\`; "skip everything" or "just publish it" is \`--skip all\`; "don't wait on the Vercel preview" is \`--ignore-check 'Vercel*'\`.

Stop the whole flow and tell the user if any part of this step leaves something unresolved (a check it couldn't fix, a source bug a test found, a change elsewhere that needs judgment, a migration). Don't go on to sync with known-broken local state.

### 1a. Survey

1. **Base branch:** \`{{command:configure}} get repo.baseBranch\` prints \`{"values": {"repo.baseBranch": "<base>"}}\`. ${REQUIRE_CONFIG}
2. **Integrations:** \`{{command:configure}} integrations sourceControl stacking --optional\`. ${USE_INTEGRATIONS}
   - **Source control:** keep the entry whose repository (from its \`values\`) is this checkout's \`origin\` in \`git remote -v\`. With none, stop: \`No configured source-control repository is this checkout's origin. Run {{cmd}}configure sourceControl, then re-run.\` With one at \`level\` \`read\`, stop too: \`The team uses <entry> read-only, so ready can't push, mark pull requests ready, or resolve review threads. Run {{cmd}}configure <integration> to change that.\`
   - **Stacking:** the first entry, if any.
3. **Pull request:** the source-control entry's \`currentPr\` op: \`<pr>\` is its number, or none.
4. **Parent:** ${STACK_PARENT}
5. **Scope:** \`{{command:ready}} plan --base <landed, else parent>\`, plus each \`--skip\` and \`--ignore-check\` from the flags as given (quote each pattern for the shell), fetches the parent and prints JSON: \`mergeBase\` (keep it as \`<mergeBase>\` for the whole flow, so a base that moves meanwhile doesn't change the scope), \`ahead\`, \`dirty\`, \`changed\` (every file the pull request will hold: committed since the merge base, uncommitted, and untracked), \`packages\` (each touched package's directory, manifest, how to run its scripts, and its fix and check scripts), \`instructions\` (the agent instruction files at the root and above each changed file), \`commands\` (the config's \`ready\` section, with \`{base}\` filled in), \`skip\` (the steps this run skips: the config's \`ready.skip\` and the flags'), \`ignoreChecks\` (the CI check patterns this run ignores: the config's \`ready.ignoreChecks\` and the flags'), and \`logDir\`. Keep \`skip\` and \`ignoreChecks\` for the whole flow: every step below names the \`skip\` entry that turns it off. If it fails because HEAD is detached, stop and tell the user to check out a branch; because it can't skip a step, relay its message and the usage block from \`help\`, and stop.
6. **Anything to publish?** With no pull request, \`ahead\` 0, and \`dirty\` false, stop: \`Nothing to publish: no pull request, and no work ahead of <parent>.\`
7. **The repo's \`before\` hooks:** \`{{command:hooks}} run ready.before --flow ready --mode <mode> --base <mergeBase>\`. ${HOOK_RESULTS} They run whatever \`skip\` says: they're the repo's own requirements, not ready's steps. When they changed files, run the scope (5) again, with the same flags, so the steps below see them.

Read every file in \`instructions\` you haven't already: they're where the repo says what must change together and how to check it, and they win over anything below.

### 1b. What must change together

**Skip when \`skip\` has \`cleanup\`.** Walk the changed files against the repo's rules, from the agent instructions first, then the repo's own evidence:

- **Docs:** a change to a public API, a command, a config field, or an install step, and the docs or README that describe it.
- **Mirrors:** files the instructions say are kept in step (two implementations of one interface, a rule written in two places, one skill per host).
- **Generated files:** output the repo commits (built skills, clients, lockfiles); regenerate it with the repo's command when its source changed.
- **Version and changelog:** a bump or changelog entry the repo's instructions or CI require for a package the branch changed, made with the repo's own command, at the smallest level.
- **Schema:** a schema change with no matching migration. **Stop and tell the user**; never write or apply one.

Fix what's missing when it's straightforward; flag it when it needs judgment. Only flag what genuinely applies (a dev-dependency bump doesn't need docs). Keep this quick.

### 1c. Tests

**Skip when \`skip\` has \`tests\`.** Find source files in \`changed\` with new or changed behavior and no matching test change. Write or extend tests for that behavior, following the package's test conventions. When a test shows a source bug, flag it; don't change the source to make it pass.

### 1d. Fix, then check

**Skip the fix commands when \`skip\` has \`fix\`, and the check commands when it has \`checks\`;** with both, skip this step. Skipping \`checks\` doesn't skip CI: that's \`ci\`.

**Which commands:** the config's \`commands\` when \`commands.configured\` is true: \`fix\` then \`checks\`, from the repo root, as given. Otherwise, per touched package, what its agent instructions say to run before committing, else its own scripts from \`packages\`: fix scripts first (\`lint:fix\`, \`format\`, \`fix\`), then checks in this order: lint and type checks (\`lint\`, \`check\`, \`validate\`, \`typecheck\`, \`tsc\`), the **relevant tests**, then \`build\` when the package builds something the checks read. For a package with no scripts (\`manifest\` not \`package.json\`), use its toolchain's usual lint and test commands as its instructions name them. A root package (\`dir\` \`.\`) runs only when its own files changed, unless the instructions say its scripts cover the others.

**Relevant tests, not the suite:** the test files that changed, the tests next to each changed file, and the tests that import one directly, through the test runner's own selection when it has one (\`--changed <mergeBase>\`, \`related\`). After a failure, rerun only the failing files until they pass. Run a package's whole suite only when the user asks, or to reproduce a CI-only failure that can't be isolated: CI runs the full suite after publishing.

**Order and concurrency:** run every fix command (and generators, and the edits from 1b and 1c) before any check starts, since a check must not read files still being rewritten. Then run independent packages' checks at most two at a time, each package's in order, building a shared package before the ones that use it. Keep going with other packages after a failure, but skip the ones that depend on a package that failed.

**Never** run a script that deploys, publishes, migrates, or writes to a database or shared service, even as part of a build: read a \`build\` or \`validate\` script before running it, and use a side-effect-free variant (or skip it and say so) when it has one of those steps.

**Keep the output out of context.** Run every check (not fix commands, whose short output says what they changed) as:

\`\`\`bash
${CAPPED}
\`\`\`

On success that shows up to 20 warning and error lines from anywhere in the log, then its summary; on failure, the last 200 lines. Fix warnings as well as errors (CI often treats some as failures), and rerun the package's lint after the last fix until it reports nothing.

### 1e. Rescan

Skip when \`skip\` has both \`fix\` and \`checks\`: there's nothing to run for new packages. Otherwise run \`{{command:ready}} plan --base <landed, else parent>\` again, with the same flags. When the edits above touched packages that weren't in \`packages\` before, run 1d for them. This rescan is what keeps a stale first plan from skipping files the cleanup itself changed.

### 1f. Before publishing

\`{{command:hooks}} run ready.beforePublish --flow ready --mode <mode> --base <mergeBase>\`, whatever \`skip\` says. ${HOOK_RESULTS} Sync commits what they change with the rest. When they changed source files and \`skip\` doesn't have \`checks\`, rerun 1d's checks for those packages first.`,
          next: {
            byMode: {
              default: "run/sync-local",
              loop: "run/sync-local",
              draft: "run/sync-local",
              help: null,
            },
          },
        },
      ],
    },
    {
      id: "run",
      title: "Run",
      stepStyle: "headers",
      steps: [
        {
          id: "sync-local",
          kind: "action",
          title: "Sync (local pass)",
          refName: "sync local",
          body: `Run the \`{{cmd}}sync\` skill with the argument \`local\`: invoke it, don't redo its steps. It commits pending work (the cleanup included), catches up to the base, and leaves the branch ahead of its remote; \`local\` never pushes, opens a pull request, or touches the issue. The publish step owns the push.

When sync stops (a conflict it needs you for, a hook it couldn't satisfy), stop too and pass its message on.

**No-op rule.** When sync has nothing to commit or catch up, carry on: an existing pull request can still need marking ready, its body refreshed, review threads addressed, or CI fixed. Stop only when there's no pull request and nothing ahead of the base: there's no work to publish.`,
          next: "run/publish",
        },
        {
          id: "publish",
          kind: "action",
          title: "Publish",
          refName: "publish",
          commandCalls: ["ready"],
          body: `The source-control and stacking entries, \`<base>\`, and \`<parent>\` are from 1a of {{skill-ref:main}}. Re-run \`currentPr\`: sync may have changed things.

### Push

Skip the push when the branch's remote has this exact commit: \`git fetch origin <branch>\` and \`git rev-parse HEAD\` equals \`git rev-parse origin/<branch>\`.

- **With a stacking integration:** its \`submit\` op. It pushes and opens the pull request as a draft when there's none, and leaves an existing one's title, body, and draft or ready state alone. When it says the branch isn't tracked, run its \`track\` op with \`<parent>\`, then \`submit\` again.
- **Without one:** \`git push -u origin HEAD\`. If it's rejected because the remote branch moved, \`git fetch origin <branch>\`, \`git merge --no-edit origin/<branch>\`, resolve as sync does, and push again. Never force.

### Pull request

When there's still none (no stacking integration, or one whose \`submit\` didn't open it): the \`prCreate\` op with \`<base>\` \`<parent>\`, a title in the repo's convention (its agent instructions, then the shape of recent subjects on the base, \`git log -20 --format=%s <parent>\`), and an empty body file. The remote sync below writes the body; anything put there now would survive it as text outside sync's block. Quote the title for the shell: single quotes, with any \`'\` written as \`'\\''\`.

Then the \`prMergeability\` op: \`pending\` → wait 3 seconds and ask again, up to 3 times, then treat it as clean; \`conflicting\` or \`behind\` → run the \`{{cmd}}sync\` skill with \`local\` once more, push again, and ask again. Still not clean: stop and show the user what the op returned.

### Mark ready

**Skip in \`draft\` mode**: the pull request stays a draft. Otherwise, when \`currentPr\` says it's a draft, the \`prReady\` op. Already ready: nothing to do; note it for the report.

### Start the CI pass

**Skip when \`skip\` has \`ci\`:** no pass, no waiter.

\`<sha>\` is \`git rev-parse HEAD\`, the commit just published. Run \`{{command:ready}} ci start --sha <sha>\`: it starts this commit's pass (its 15-minute clock, and the record later snapshots are compared against). Print \`Ready CI pass <pass>: waiting up to 15 minutes for <short sha>.\`

When the \`checks\` op has a \`script\` variant that runs here, start the waiter now, in the background if this host can run a command in the background, so the remote sync overlaps the wait:

\`\`\`bash
{{command:ready}} ci wait --sha <sha> --command '<the checks op's script variant, with <sha> filled in>' [--ignore-check '<pattern>']...
\`\`\`

with an \`--ignore-check\` for each entry of \`ignoreChecks\` from 1a of {{skill-ref:main}}. It polls every 30 seconds until every check settles or the pass times out, prints \`[ready-ci]\` progress and each new failure to stderr, and the final report to stdout. Read its progress at least once a minute and relay it in one line. Keep its handle: the CI step joins it, and never starts a second waiter for the same commit. Pinning it to the local \`<sha>\` keeps a lagging pull request head from making it watch the previous commit. When the host limits how long one command runs, add \`--max-wait <a bit under that limit>\` and run it again until it settles: the pass's clock started at \`ci start\`, so a rerun keeps the same deadline.`,
          next: "run/sync-remote",
        },
        {
          id: "sync-remote",
          kind: "action",
          title: "Sync (remote pass)",
          refName: "sync remote",
          body: `Run the \`{{cmd}}sync\` skill with the argument \`remote\`. It refreshes everything outside the git tree against the published state: the pull request's body and title, the issue's description and Status, and the issue's state, which follows the pull request (now \`in review\` once it's ready; still \`in progress\` in \`draft\` mode). It never commits, pushes, or creates a pull request, so the push above has to come first.

Run it even when the local sync and the publish changed nothing: an already-published pull request can still need its links or issue state refreshed. When it fails, say so in the report and carry on to CI: the remote sync can be re-run on its own.`,
          next: "run/ci",
        },
        {
          id: "ci",
          kind: "action",
          title: "CI",
          refName: "ci",
          commandCalls: ["ready"],
          body: `Read every check and the automated reviewers' threads, fix what's high-confidence, push, and in \`loop\` mode repeat. ${CONFIDENCE}

**Skips** (\`skip\` and \`ignoreChecks\` from 1a of {{skill-ref:main}}):

- \`ci\`: don't wait for the checks, read their logs, or fix them. With \`reviews\` too, skip this step and go to the report. Otherwise handle only the automated reviewers' threads, once: read them, fix and push as below (with no \`ci start\` after the push), resolve what shipped, and go to the report. \`loop\` mode has no run to watch, so it makes this one pass.
- \`reviews\`: don't read, fix, or resolve review threads, and a green pass doesn't wait on them.
- \`ignoreChecks\`: pass an \`--ignore-check\` for each to every \`ci wait\` and \`ci record\`. Those checks aren't waited on, counted, or failed; the report lists them as \`ignored\`. Never fix an ignored check, even when its failure is plain.

**Settled** means every check has reached \`pass\`, \`skipping\`, \`fail\`, or \`cancelled\`; a \`pending\` check isn't settled, and CI is green only once every check settled with none failed. In \`loop\` mode, prepare fixes for visible failures while other checks still run, but **never commit or push until the commit's checks have all settled**: that keeps the rest of the run's signal and puts every fix from it in one push. A pass waits at most 15 minutes; past that, list what's still pending (\`Timed out waiting for checks to settle (15m). Still pending: <names>. These may need manual inspection.\`) and exit without pushing partial fixes.

### Wait for the checks

Join the waiter the publish step started. When there's none (the op has no \`script\` variant that runs here, or its handle was lost), wait in the foreground: with a \`script\` variant, \`ci wait\` as in the publish step; without one, every 30 seconds run the \`checks\` op for \`<sha>\`, write its JSON (in the shape the op describes) to a file, and run \`{{command:ready}} ci record --sha <sha> --file <file>\` (with the \`--ignore-check\` flags), until it says \`settled\` or \`timedOut\`. Never poll with a second waiter for the same commit.

Each report has \`settled\`, \`timedOut\`, \`green\`, \`noChecks\`, \`counts\`, \`pending\`, \`failures\` (each with its \`name\`, \`state\`, \`link\`, and \`log\`), \`newFailures\` (not reported before in this pass), \`stalled\`, and \`ignored\` (checks left out by \`ignoreChecks\`). Use them as given: the last report once settled is the authority for this pass.

- \`noChecks\`: nothing reported on the commit within 3 minutes, so the repo runs no CI on it, or every check reported is ignored. Say which in the report and skip to the review threads.
- \`timedOut\`: list \`pending\` and stop as above.
- \`stalled\` not empty: checks a fix was pushed for failed again. The fix didn't work: stop and hand them to the user with their logs. Don't push again.

In \`loop\` mode, act on each \`newFailures\` entry as it arrives (from the waiter's \`[ready-ci]\` lines or a record): read its log, categorize it, and prepare a high-confidence fix **locally only**.

### Read the failures

For each failure with a \`log\`, the \`checkLog\` op with \`<log>\`; read logs for failures visible at the same time in parallel, but edit files one at a time. A failure with no \`log\` is an outside service's status: its \`link\` is all there is, so name it in the report rather than guess at it.

Then, unless \`skip\` has \`reviews\`, the \`reviewThreads\` op for the pull request. A thread is an **automated reviewer's** when its first comment's author is a bot, or is a reviewer the repo's agent instructions name as automated. Read only those threads' comments; leave people's threads to the people (count them for the report). Do this once per settled pass, not on every poll.

### Categorize

| Bucket | Trigger | What to do |
|---|---|---|
| **Local check miss** | A lint, format, type, test, or build check fails on code the branch touched | Reproduce the one failing check or test file locally with the command chosen in 1d of {{skill-ref:main}}, fix it, and keep it local until the batch push. Run the cleanup again only when the failure shows its scope missed something |
| **Required bookkeeping** | A check says a version bump, changelog entry, or regenerated file is missing | Make it with the repo's own command, at the smallest level. A bigger bump looks warranted: stop |
| **Automated review** | An unresolved thread from an automated reviewer | A mechanical, unambiguous suggestion: apply it, and resolve the thread after the push. A judgment call: stop |
| **Migration or schema** | A check finds a schema change with no migration, or a migration problem | Stop: migrations need the user's approval |
| **Dependency or toolchain version** | A check wants a dependency, runtime, or tool version moved or aligned | Stop: that's the team's decision |
| **Cancelled** | A check ended \`cancelled\` | Stop: don't read a cancellation as a pass |
| **Not the branch's** | Infrastructure, a flaky test, a timeout, or a failure in code the branch doesn't touch | Stop, with the check's name and log tail |
| **Other** | Anything else | Only a non-controversial fix (mechanical, one obvious correction, no source-logic judgment, no new dependency, no scope or infrastructure change). Otherwise stop, with the check's name and log tail |

On a **stop** bucket, don't attempt the uncertain fix and don't push any partial fix. In \`loop\` mode before the commit settles, note the blocker and keep waiting, so the report has every failure from that commit; surface them all together once it settles.

### Fix and push

Apply the high-confidence fixes in this order, so later ones build on earlier ones: local check misses, then required bookkeeping, then automated review suggestions. After each bucket, \`git status --short\` must show a change; a fix that produced no diff is a stalled fix: stop and surface it.

Once the commit's checks have all settled, with no stop bucket and at least one fix, **rerun the local checks** on the batch before committing it, so a fix push never trades one failure for another: the fix commands, then the check commands, chosen as in 1d of {{skill-ref:main}} (the config's \`commands\`, else the touched packages' scripts with the relevant tests), run and capped the same way, minus what \`skip\` turns off there (\`fix\`, \`checks\`). Rerun them for every package the branch touches, not only the ones the fixes did. A failure the batch caused gets a high-confidence fix and another rerun; one it didn't cause, or one that survives a fix, is a stop: report it and don't push. Then commit them in one batch: \`git add -A\`, then \`git commit -m "<message>"\` in the repo's convention (\`CI: address review comments\`, say). Push as the publish step does: the stacking entry's \`submit\`, else \`git push origin HEAD\`. The push leaves the pull request's draft or ready state alone. Then:

\`\`\`bash
{{command:ready}} ci start --sha <the new HEAD> --fixed <check name>...
\`\`\`

with a \`--fixed\` for each failed check the batch meant to fix, so the next pass can tell a fix that didn't work.

**Resolve review threads** only after that push succeeds: for each automated reviewer's thread whose fix is now on the remote, the \`resolveThread\` op. A thread whose fix stayed local (a stop, a failed commit or push) stays unresolved, so the host never claims an unshipped fix. Never resolve a person's thread. A resolve that fails gets a one-line warning, not a stop.

### Loop or exit

- **\`default\` and \`draft\` mode:** one pass. Go to the report; don't wait for the run the fix push started.
- **\`loop\` mode:** a stop bucket or a stalled fix ends it: report the blockers and exit without pushing. A fix push starts the next pass: print \`Ready CI pass <pass>: waiting up to 15 minutes for <short sha>.\`, start one waiter for the new commit as the publish step does, and come back to *Wait for the checks*. A pass that settled green, with no automated reviewer's thread left unresolved (unless \`skip\` has \`reviews\`), ends it successfully. Report success only for a commit you saw go green; never because a number of passes or minutes went by.

\`loop\` mode is a long-running foreground task by design: the user asked you to sit on it. Run the waiter in the background only so you can keep fixing while it waits, never to end your turn and come back later.`,
          next: "run/report",
        },
        {
          id: "report",
          kind: "action",
          title: "Report",
          refName: "report",
          body: `Lead with anything that needs the user's attention: every stop bucket and stalled fix with the check's name and log tail, what you would have done and why you didn't, a failed remote sync, a timeout. Don't bury it under the rest. Then:

- **Mode** that ran (\`default\`, \`loop\`, or \`draft\`), the steps it skipped, and the CI check patterns it ignored, each with where it came from (the config or a flag).
- **Local cleanup:** clean, fixed N things (what changed together, tests written, check fixes), or surfaced N for the user; the packages checked and with which commands.
- **Sync (local):** committed, caught up (and any conflicts resolved, by file), or nothing to do.
- **Publish:** pushed or already published; pull request opened or existing; marked ready, already ready, or left a draft in \`draft\` mode; its mergeability.
- **Sync (remote):** the pull request and issue URLs, and the issue's state.
- **CI:** in \`loop\` mode, the passes it waited on, the fix pushes, the final state of the checks, and which exit it took; otherwise, what the one pass fixed and pushed, and what's left for the next run. Pass and fail counts for the last settled commit, and the checks it ignored. With \`ci\` skipped: \`CI: skipped\`.
- **Review threads:** \`Automated review: N open / M resolved this run\`, always, even when both are 0, and the number of people's threads still open. With \`reviews\` skipped: \`Automated review: skipped\`.`,
          next: null,
        },
      ],
    },
  ],
})

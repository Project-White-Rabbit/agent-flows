---
description: Take finished branch work to a ready, green pull request: scoped local cleanup and checks, commit, publish, mark it ready, and fix CI with high confidence. Not for merging, reviewing, or one-off checks.
argument-hint: "[loop|draft|help] [--skip <steps>] [--ignore-check <pattern>]..."
---

# /dev-flows:ready

Take a branch from "I think I'm done" to "this pull request is ready and green." It bundles scoped local cleanup (what must change together, tests, the repo's own fix and check commands for what the branch touches), `/dev-flows:sync local`, the push and the draft-to-ready flip, `/dev-flows:sync remote`, and a CI fix pass into one command. Local checks cover what the branch touches; CI stays the full-suite backstop. The two sync calls bookend the publish on purpose: `local` commits the cleanup without touching anything remote, publish pushes and marks the pull request ready in one beat, and `remote` refreshes the pull request body and its issue against the published state (so the issue moves to in review). Every vendor-specific action goes through the repo's configured integrations (`/dev-flows:configure`), so the same skill works with any source-control host and CI, with or without a stacking tool. Any step can be skipped, and any CI check ignored, from the config's `ready` section or for one run with `--skip` and `--ignore-check`.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `hooks.ts <subcommand>` | `run <point>... --flow <flow>` runs the repo's hooks at those points, in order, and prints what to do next: `done`, a task for you (`agent`), or a failure that stops the command (`stop`) |
| `configure.ts <subcommand>` | `get <path>...` prints configured values; `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Both exit 2 when the repo isn't configured for what's asked |
| `ready.ts <subcommand>` | `plan` scopes the branch (merge base, changed files, touched packages and their check scripts, agent instructions, the config's ready commands, and the steps to skip and CI checks to ignore); `ci start`, `ci record`, and `ci wait` track each pushed commit's CI pass: settled, timed out, new failures, and fixes that didn't work |

## Invariants

- This command fixes CI failures itself. **Every fix must be high-confidence; if it isn't, stop and ask.** High-confidence: a lint, format, or type error with one obvious fix; a test that fails because the test itself is out of date with a change the branch meant to make; a version bump or changelog entry a check requires, made with the repo's own command for it, at the smallest level; generated files regenerated with the repo's command; an automated reviewer's suggestion that is mechanical and unambiguous (a rename, a null check, a missing `await`). Stop and ask when: a test fails for a reason that needs a change to source logic; a type error means a real API change; a review comment needs a judgment call (architecture, scope, behavior); the same failure survives a fix attempt; the failure is in infrastructure, is flaky, or is in code the branch doesn't touch; a version bump past the smallest level looks warranted; it involves a database migration or a dependency or toolchain version; anything unfamiliar. The bar: if you'd write a comment apologizing for a wrong guess, don't make the guess. Hand it back.
- **Act through the integrations' ops.** Pull requests, checks, logs, review threads, and stacks are reached only through the ops `configure.ts integrations` returns, run as given. Plain `git` is fine for everything local.
- **Sync owns the pull request's body and the issue.** Ready never writes either; it runs `/dev-flows:sync` for them.
- **Never rewrite pushed history yourself, and never force-push.** Without a stacking integration, catch up by merging; with one, its `restack` and `submit` ops own the rebase and the push.
- **Never use destructive escapes** (`git reset --hard`, `git rebase --abort`, `git stash`, `git push --force` without `--force-with-lease`) to get out of a conflict.
- **Never run a command with side effects outside the checkout** to check the branch: nothing that deploys, publishes, migrates or writes to a database, or calls a shared service. Read a script before running it when its name doesn't make that plain.
- **Never create, edit, or apply a database migration, and never move a dependency or toolchain version** to make a check pass. Those are the team's decisions: surface them.
- **Only change tests when fixing a failing test**, never source. A test that shows a source bug is the user's to look at.
- **Run the repo's hooks around this command.** Skip this when the mode is `help`, or when another dev-flows command is running this one (it runs its own). Once the mode is known, before the first step's work: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run before --flow ready --mode <mode>`. When the command ends, finished or stopped, just before its report or before telling the user why it stopped: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run ready.after after --flow ready --mode <mode> --base <mergeBase> --outcome <success, when it did its job, else failure>`, leaving out a flag whose value isn't known yet. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop. At the end, a `stop` can't happen: report the `failures`. Say in the report which hooks ran at each point, what any task for you changed, and what failed.

## Modes

Read `$ARGUMENTS` first. If its first token is exactly one of the mode names below, run that mode. Otherwise, when this skill documents how to route the remaining arguments (see its intro), follow that; if it doesn't, run `default` and treat `$ARGUMENTS` as its input. Follow only the selected mode's path below.

| Mode | Trigger | What it does |
|------|---------|--------------|
| `default` | (no argument) | Run the full pipeline: local cleanup, sync local, publish and mark the PR ready, sync remote, then one CI fix pass. |
| `loop` | `loop` | Same pipeline, then babysit CI until every check is green or progress stalls. |
| `draft` | `draft` | Same pipeline, but leave the PR a draft: everything except marking it ready. |
| `help` | `help` | Show usage and exit without running the pipeline. |

## 0. Help shortcut

**Run only when mode is `help`.**

If mode is `help`, print the block below verbatim and exit. No reads, no writes.

```
/dev-flows:ready  [loop | draft | help] [--skip <steps>] [--ignore-check <pattern>]...

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
  2. /dev-flows:sync local: commit and catch up to the base, no push
  3. Publish: push, open the pull request if there's none, mark it
     ready (not in draft)
  4. /dev-flows:sync remote: refresh the pull request body and its issue
  5. CI: wait for the checks (ci), and read automated reviewers'
     threads (reviews); fix what's high-confidence, push once

It uses the integrations in .agent-flows/config.json: source control
for the pull request, its checks, and its review threads (at write
level), and a stacking tool when there is one. The config's `ready`
section can name the fix and check commands; otherwise it runs the
scripts of each package the branch touches, as the repo's agent
instructions say. Its `skip` and `ignoreChecks` lists apply to every
run; the flags add to them. Its `before`, `beforePublish`, and
`after` hooks, and the general ones in the `hooks` section, run
whatever is skipped.
```

## 1. Local cleanup

**Run only when mode is `default`, `loop` or `draft`.**

Parse the argument for a mode keyword (`loop`, `draft`, `help`). No keyword means default mode.

**Flags:** take `--skip <steps>` (comma-separated, may repeat) and `--ignore-check <pattern>` (may repeat) out of the arguments, for the plan below. Any other argument that starts with `--` is a flag this command doesn't take: name it, print the usage block from `help`, and stop, rather than running without it. A `--` inside pasted notes, a quoted value, or a command the notes quote (`git push --force`) is part of that text, not a flag. Read plain words the same way: "don't write tests" is `--skip tests`; "skip the local checks" is `--skip local`; "don't wait for CI" or "just push it" is `--skip ci`; "ignore the review bots" is `--skip reviews`; "skip everything" or "just publish it" is `--skip all`; "don't wait on the Vercel preview" is `--ignore-check 'Vercel*'`.

Stop the whole flow and tell the user if any part of this step leaves something unresolved (a check it couldn't fix, a source bug a test found, a change elsewhere that needs judgment, a migration). Don't go on to sync with known-broken local state.

### 1a. Survey

1. **Base branch:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" get repo.baseBranch` prints `{"values": {"repo.baseBranch": "<base>"}}`. If it exits with status 2 and prints `"configured": false`, stop this command here. Relay its `message`: the repo isn't set up for dev-flows yet, its config is invalid (`issues`), or it doesn't set what this command needs (`missing`: config paths, or capabilities with no integration). Tell the user to run `/dev-flows:configure` (naming the missing sections or capabilities, if any) and then re-run this command. Don't guess the values instead.
2. **Integrations:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations sourceControl stacking --optional`. Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `script` (an adapter: the op as code, built in or the repo's own; run it, and when it exits 3 it can't run here, so go on to the next), `mcp` when this session has tools from an MCP server whose name contains `access.mcp.server` (tools that are deferred, or from a server still connecting, count: search for them with your tool search before deciding they're missing), `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. Run the chosen variant as given rather than a tool you know. When no variant of an op works, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them.
   - **Source control:** keep the entry whose repository (from its `values`) is this checkout's `origin` in `git remote -v`. With none, stop: `No configured source-control repository is this checkout's origin. Run /dev-flows:configure sourceControl, then re-run.` With one at `level` `read`, stop too: `The team uses <entry> read-only, so ready can't push, mark pull requests ready, or resolve review threads. Run /dev-flows:configure <integration> to change that.`
   - **Stacking:** the first entry, if any.
3. **Pull request:** the source-control entry's `currentPr` op: `<pr>` is its number, or none.
4. **Parent:** With a stacking entry, its `parent` op. When that succeeds and names a branch other than `<base>`, check it hasn't already merged: the source-control entry's `branchPr` op for it (with no source-control entry, skip the check). Merged means it landed, so `<parent>` is the base that pull request merged into, and `<landed>` is the old parent: `/dev-flows:sync` moves the branch off it (until then, the branch still holds the landed parent's commits, so compare its own work against `<landed>`, not `<parent>`). Otherwise `<parent>` is the branch the op named. When there's no stacking entry, or its `parent` op fails (the branch isn't tracked): the pull request's base branch when there's a pull request, else `<base>`.
5. **Scope:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" plan --base <landed, else parent>`, plus each `--skip` and `--ignore-check` from the flags as given (quote each pattern for the shell), fetches the parent and prints JSON: `mergeBase` (keep it as `<mergeBase>` for the whole flow, so a base that moves meanwhile doesn't change the scope), `ahead`, `dirty`, `changed` (every file the pull request will hold: committed since the merge base, uncommitted, and untracked), `packages` (each touched package's directory, manifest, how to run its scripts, and its fix and check scripts), `instructions` (the agent instruction files at the root and above each changed file), `commands` (the config's `ready` section, with `{base}` filled in), `skip` (the steps this run skips: the config's `ready.skip` and the flags'), `ignoreChecks` (the CI check patterns this run ignores: the config's `ready.ignoreChecks` and the flags'), and `logDir`. Keep `skip` and `ignoreChecks` for the whole flow: every step below names the `skip` entry that turns it off. If it fails because HEAD is detached, stop and tell the user to check out a branch; because it can't skip a step, relay its message and the usage block from `help`, and stop.
6. **Anything to publish?** With no pull request, `ahead` 0, and `dirty` false, stop: `Nothing to publish: no pull request, and no work ahead of <parent>.`
7. **The repo's `before` hooks:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run ready.before --flow ready --mode <mode> --base <mergeBase>`. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop. They run whatever `skip` says: they're the repo's own requirements, not ready's steps. When they changed files, run the scope (5) again, with the same flags, so the steps below see them.

Read every file in `instructions` you haven't already: they're where the repo says what must change together and how to check it, and they win over anything below.

### 1b. What must change together

**Skip when `skip` has `cleanup`.** Walk the changed files against the repo's rules, from the agent instructions first, then the repo's own evidence:

- **Docs:** a change to a public API, a command, a config field, or an install step, and the docs or README that describe it.
- **Mirrors:** files the instructions say are kept in step (two implementations of one interface, a rule written in two places, one skill per host).
- **Generated files:** output the repo commits (built skills, clients, lockfiles); regenerate it with the repo's command when its source changed.
- **Version and changelog:** a bump or changelog entry the repo's instructions or CI require for a package the branch changed, made with the repo's own command, at the smallest level.
- **Schema:** a schema change with no matching migration. **Stop and tell the user**; never write or apply one.

Fix what's missing when it's straightforward; flag it when it needs judgment. Only flag what genuinely applies (a dev-dependency bump doesn't need docs). Keep this quick.

### 1c. Tests

**Skip when `skip` has `tests`.** Find source files in `changed` with new or changed behavior and no matching test change. Write or extend tests for that behavior, following the package's test conventions. When a test shows a source bug, flag it; don't change the source to make it pass.

### 1d. Fix, then check

**Skip the fix commands when `skip` has `fix`, and the check commands when it has `checks`;** with both, skip this step. Skipping `checks` doesn't skip CI: that's `ci`.

**Which commands:** the config's `commands` when `commands.configured` is true: `fix` then `checks`, from the repo root, as given. Otherwise, per touched package, what its agent instructions say to run before committing, else its own scripts from `packages`: fix scripts first (`lint:fix`, `format`, `fix`), then checks in this order: lint and type checks (`lint`, `check`, `validate`, `typecheck`, `tsc`), the **relevant tests**, then `build` when the package builds something the checks read. For a package with no scripts (`manifest` not `package.json`), use its toolchain's usual lint and test commands as its instructions name them. A root package (`dir` `.`) runs only when its own files changed, unless the instructions say its scripts cover the others.

**Relevant tests, not the suite:** the test files that changed, the tests next to each changed file, and the tests that import one directly, through the test runner's own selection when it has one (`--changed <mergeBase>`, `related`). After a failure, rerun only the failing files until they pass. Run a package's whole suite only when the user asks, or to reproduce a CI-only failure that can't be isolated: CI runs the full suite after publishing.

**Order and concurrency:** run every fix command (and generators, and the edits from 1b and 1c) before any check starts, since a check must not read files still being rewritten. Then run independent packages' checks at most two at a time, each package's in order, building a shared package before the ones that use it. Keep going with other packages after a failure, but skip the ones that depend on a package that failed.

**Never** run a script that deploys, publishes, migrates, or writes to a database or shared service, even as part of a build: read a `build` or `validate` script before running it, and use a side-effect-free variant (or skip it and say so) when it has one of those steps.

**Keep the output out of context.** Run every check (not fix commands, whose short output says what they changed) as:

```bash
(<command>) > <logDir>/<package>-<step>.log 2>&1 && { grep -iE "(warning|error)" <logDir>/<package>-<step>.log | head -20; tail -10 <logDir>/<package>-<step>.log; } || tail -200 <logDir>/<package>-<step>.log
```

On success that shows up to 20 warning and error lines from anywhere in the log, then its summary; on failure, the last 200 lines. Fix warnings as well as errors (CI often treats some as failures), and rerun the package's lint after the last fix until it reports nothing.

### 1e. Rescan

Skip when `skip` has both `fix` and `checks`: there's nothing to run for new packages. Otherwise run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/ready.ts" plan --base <landed, else parent>` again, with the same flags. When the edits above touched packages that weren't in `packages` before, run 1d for them. This rescan is what keeps a stale first plan from skipping files the cleanup itself changed.

### 1f. Before publishing

`node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run ready.beforePublish --flow ready --mode <mode> --base <mergeBase>`, whatever `skip` says. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop. Sync commits what they change with the rest. When they changed source files and `skip` doesn't have `checks`, rerun 1d's checks for those packages first.

**Next:**

- Mode `default` or `loop` or `draft`: invoke the `ready-run` skill with the current mode (`default` or `loop` or `draft`), forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).

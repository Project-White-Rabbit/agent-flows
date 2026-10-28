---
description: Land the current branch's pull request (or its stack): wait for CI on the commit that lands, merge it through the repo's source-control or stacking integration, then close out its issue and errors. Only when the user explicitly asks to land or merge the PR, never for a git merge.
argument-hint: "[stack | branch] [squash | merge | rebase]"
---

# /dev-flows:merge

Take the current branch from "in flight" to "merged" in one command: the last step of the dev workflow. It picks up where `/dev-flows:sync` and `/dev-flows:ready` left off, and runs `/dev-flows:sync` itself when the branch has no pull request yet. It waits for CI on the exact commit that lands, merges it, deletes the remote branch, and runs `/dev-flows:sync remote` so the issue moves to done and linked errors resolve. Every vendor-specific action goes through the repo's configured integrations (`/dev-flows:configure`): the source-control host merges a single branch, and a stacking tool, when there is one, lands a whole stack.

**Arguments**, in any order:

- `stack` lands every branch from the base up to and including this one; `branch` (or `no-stack`) lands only this one. Neither: when branches sit below this one in its stack, ask; otherwise only this one lands. Branches above this one are never touched.
- `squash`, `merge` (or `no-squash`), or `rebase` picks the merge method for a single branch. Neither: `squash`, or `merge` when the branch is part of a stack of more than one, so each stacked pull request keeps its own boundary in the base's history. A stack lands by the stacking tool's or the host's own method, so a method passed with `stack` isn't used: say so in the report.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `hooks.ts <subcommand>` | `run <point>... --flow <flow>` runs the repo's hooks at those points, in order, and prints what to do next: `done`, a task for you (`agent`), or a failure that stops the command (`stop`) |
| `configure.ts <subcommand>` | `get <path>... [--optional]` prints configured values (`null` for an unset one with `--optional`); `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Both exit 2 when the repo isn't configured for what's asked |
| `ready.ts <subcommand>` | `ci start` and `ci wait` track the CI pass on the commit about to land: settled, timed out, and what failed |

## Invariants

- **Invoking this command is the authorization to merge.** Don't ask for a second confirmation. The one question it asks is how much of a stack to land, and only when nothing said.
- **Act through the integrations' ops.** Pull requests, checks, merges, and stacks are reached only through the ops `configure.ts integrations` returns, run as given. Plain `git` is fine for everything local.
- **Never bypass the host:** no admin merge, no auto-merge, no skipping a required check or review, no rerunning someone's CI to get past it.
- **Nothing is pushed between the CI pass and the merge.** The merge is pinned to the commit CI passed on; a head that moved since stops it.
- **Clean up only after the host says merged.** No branch deletion, issue update, or error resolution for a pull request that isn't merged.
- **Run the repo's hooks around this command.** Skip this when the mode is `help`, or when another dev-flows command is running this one (it runs its own). Once the mode is known, before the first step's work: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run before --flow merge --mode <mode>`. When the command ends, finished or stopped, just before its report or before telling the user why it stopped: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run merge.after after --flow merge --mode <mode> --branch <branch> --pr <N> --prs '<the numbers of every pull request it lands, bottom first, space-separated>' --outcome <success, when it did its job, else failure>`, leaving out a flag whose value isn't known yet. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop. At the end, a `stop` can't happen: report the `failures`. Say in the report which hooks ran at each point, what any task for you changed, and what failed.

## 1. Pre-flight

Reads only, apart from the sync that opens a missing pull request and the repo's own hooks. Any gate that fails stops the command with nothing written.

### 1a. Survey

1. **Arguments:** a scope (`stack`, `branch`, `no-stack`) and a method (`squash`, `merge`, `no-squash`, `rebase`), each at most once, in any order. Anything else: stop and show the usage, `/dev-flows:merge [stack | branch] [squash | merge | rebase]`.
2. **Base branch:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" get repo.baseBranch` prints `{"values": {"repo.baseBranch": "<base>"}}`. If it exits with status 2 and prints `"configured": false`, stop this command here. Relay its `message`: the repo isn't set up for dev-flows yet, its config is invalid (`issues`), or it doesn't set what this command needs (`missing`: config paths, or capabilities with no integration). Tell the user to run `/dev-flows:configure` (naming the missing sections or capabilities, if any) and then re-run this command. Don't guess the values instead. Then `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" get ready.ignoreChecks merge.closeIssue --optional`: `<ignoreChecks>`, the CI check patterns the team never waits on (`null` for none), and `<closeIssue>`, false when the issue tracker closes the issue itself on merge (`null` reads as true).
3. **Integrations:** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations sourceControl stacking --optional`. Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `script` (an adapter: the op as code, built in or the repo's own; run it, and when it exits 3 it can't run here, so go on to the next), `mcp` when this session has tools from an MCP server whose name contains `access.mcp.server` (tools that are deferred, or from a server still connecting, count: search for them with your tool search before deciding they're missing), `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. An op given as `unsupported` is one that integration has nothing for: skip what needs it, and say so in the report with its reason. Run the chosen variant as given rather than a tool you know. When no variant of an op works, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them.
   - **Source control:** keep the entry whose repository (from its `values`) is this checkout's `origin` in `git remote -v`. With none, stop: `No configured source-control repository is this checkout's origin. Run /dev-flows:configure sourceControl, then re-run.` At `level` `read`, stop too: `The team uses <entry> read-only, so merge can't land pull requests. Run /dev-flows:configure <integration> to change that.`
   - **Stacking:** the first entry, if any.
4. **Branch:** `git branch --show-current` is `<branch>`. Detached, or `<branch>` is `<base>`: stop, `Refusing to merge from <base or a detached HEAD>. Check out the feature branch first.`
5. **Pull request:** the source-control entry's `currentPr` op.

### 1b. Gates

1. **No pull request?** Say `No pull request for <branch>. Running /dev-flows:sync to open one...` and run the `/dev-flows:sync` skill with no arguments: it commits what's uncommitted, pushes, and opens the pull request and its issue. Then run `currentPr` again; still none: stop, `Sync finished but there's still no pull request. Check its output, then re-run /dev-flows:merge.` Note that sync ran, so the run phase doesn't run it again, and skip gate 2 (sync committed everything).
2. **Uncommitted changes?** `git status --porcelain` prints anything: stop, `<branch> has uncommitted changes. Commit them (or run /dev-flows:sync), then re-run /dev-flows:merge.` Don't commit them here: whether they ship is the user's call.
3. **Already merged or closed?** Merged: stop, `Pull request <N> is already merged.` (a `/dev-flows:sync remote` closes out its issue). Closed: stop, `Pull request <N> is closed. Reopen it to merge it.`

Keep the pull request's number `<N>`, URL, title, draft state, and base branch.

### 1c. Stack and method

**Parent:** With a stacking entry, its `parent` op. When that succeeds and names a branch other than `<base>`, check it hasn't already merged: the source-control entry's `branchPr` op for it (with no source-control entry, skip the check). Merged means it landed, so `<parent>` is the base that pull request merged into, and `<landed>` is the old parent: `/dev-flows:sync` moves the branch off it (until then, the branch still holds the landed parent's commits, so compare its own work against `<landed>`, not `<parent>`). Otherwise `<parent>` is the branch the op named. When there's no stacking entry, or its `parent` op fails (the branch isn't tracked): the pull request's base branch when there's a pull request, else `<base>`. With a `<landed>`, stop: `<branch> still sits on <landed>, which already merged. Run /dev-flows:sync to move it onto <parent>, then re-run /dev-flows:merge.` Merging now would land it into a branch that's already gone.

With a stacking entry, run its `downstack` op: `chain`, `above`, and `size`. Without one, the chain is `[<branch>]`, with `above` 0 and `size` 1.

**Scope:** `stack` or `branch` from the arguments. Neither, and the chain has more than one branch: show the chain bottom first, one line per branch (`#<number> <title>`, `(draft)` for a draft, the current branch marked; each branch's pull request from the `branchPr` op), then ask: `<branch> sits on <chain length - 1> other stacked branch(es). Land the whole chain, or just this branch?`, with the options `Land the whole chain` (every pull request in it merges bottom first) and `Just this branch` (only #<N> merges, into its base <the pull request's base>; the branches below stay open). Otherwise `branch`. `stack` with a chain of one is `branch`. `stack` with no stacking entry: stop, `Landing a stack needs a stacking integration. Run /dev-flows:configure stacking, or merge each pull request on its own.`

**Method**, for `branch`: the argument (`no-squash` is `merge`), else `merge` when `size` is more than 1, else `squash`. Keep why (`explicit`, `auto: stack of <size>`, or `auto: single branch`).

### 1d. Chain gates

Only for `stack`, in order:

1. **Every branch has a pull request?** The `branchPr` op for each branch in the chain. Any without one: stop, `Can't land the chain: <branches> have no pull request. Run /dev-flows:sync on each, then re-run /dev-flows:merge stack.`
2. **Every one still open?** One merged or closed means the stack's record is out of date: stop, `The stack is stale: <branch>'s pull request is <state>. Restack it (/dev-flows:sync), then re-run /dev-flows:merge.`
3. **Any already failing?** `git fetch origin <every branch in the chain>`, then for each branch the `checks` op on `git rev-parse origin/<branch>`. Any `fail` or `cancelled`: stop, naming the branch and its pull request URL, `Can't land the chain: #<number> has failing checks. Fix it with /dev-flows:ready, then re-run /dev-flows:merge stack.` A chain that stops halfway leaves part of it merged, so this is checked before anything is written.

Drafts are fine: the merge step marks them ready.

### 1e. The repo's `before` hooks

`node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run merge.before --flow merge --mode default --branch <branch> --pr <N> --prs '<numbers>'`, `<numbers>` every pull request it lands, bottom first (only `<N>` for `branch`). It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop. Merge lands what's pushed, so hooks here check rather than change: when `git status --porcelain` prints anything after them, stop as gate 2 of 1b does.

**Next:**

- Invoke the `merge-run` skill, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).

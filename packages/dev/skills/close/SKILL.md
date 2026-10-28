---
description: Abandon the current branch's work: close its pull request, delete its remote branch, cancel its issue, and run the repo's teardown. Invoking it authorizes the cleanup. Only for scrapping work without merging, never for landing it.
argument-hint: "[force|help]"
---

# /dev-flows:close

Winds down a branch whose work is being abandoned: the destructive sibling of `/dev-flows:sync`. It closes the pull request, deletes the remote branch, cancels the issue, and runs the repo's own teardown (`close.after` hooks: a database branch, dev servers, a marker a worktree setup script reads). Every vendor-specific action goes through the repo's configured integrations (`/dev-flows:configure`). The local branch and working tree are left alone, for the person (or their workspace app's teardown) to remove.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `hooks.ts <subcommand>` | `run <point>... --flow <flow>` runs the repo's hooks at those points, in order, and prints what to do next: `done`, a task for you (`agent`), or a failure that stops the command (`stop`) |
| `configure.ts <subcommand>` | `get <path>... [--optional]` prints configured values (`null` for an unset one with `--optional`); `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Both exit 2 when the repo isn't configured for what's asked |
| `sync.ts <subcommand>` | `issue` prints the issue a sync recorded for the current branch, reading only |

## Invariants

- **Invoking this command is the authorization for the cleanup.** Don't ask for a second confirmation. The one question it asks is which issue, if any, belongs to the branch when the branch never named one, and in `force` mode it asks nothing.
- **Act through the integrations' ops.** Pull requests and issues are reached only through the ops `configure.ts integrations` returns, run as given. Plain `git` is fine for the remote branch and everything local.
- **A failed read is not an absence.** A lookup that errors (sign-in, rate limit, network) stops the command before any write: mistaking it for "no pull request" could delete a branch out from under an open one.
- **Never touch the local branch or working tree:** no `git branch -D`, no switching branches, no reset or stash. Only what's remote, and what the repo's own hooks tear down.
- **Change only the issue the branch names,** or one the person picks. An issue another open pull request is attached to stays open.
- **Run the repo's hooks around this command.** Skip this when the mode is `help`, or when another dev-flows command is running this one (it runs its own). Once the mode is known, before the first step's work: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run before --flow close --mode <mode>`. When the command ends, finished or stopped, just before its report or before telling the user why it stopped: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run close.after after --flow close --mode <mode> --branch <branch> --pr <N> --outcome <success, when it did its job, else failure>`, leaving out a flag whose value isn't known yet. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop. At the end, a `stop` can't happen: report the `failures`. Say in the report which hooks ran at each point, what any task for you changed, and what failed.

## Modes

Read `$ARGUMENTS` first. If its first token is exactly one of the mode names below, run that mode. Otherwise, when this skill documents how to route the remaining arguments (see its intro), follow that; if it doesn't, run `default` and treat `$ARGUMENTS` as its input. Follow only the selected mode's path below.

| Mode | Trigger | What it does |
|------|---------|--------------|
| `default` | (no argument) | Close the pull request, delete the remote branch, cancel the issue, and run the repo's teardown. Invoking it is the confirmation, except for an issue found only by search, which it asks about. |
| `force` | `force` | The same, unattended (a workspace teardown script): it asks nothing, so an issue found only by search is listed and left open. |
| `help` | `help` | Show usage and exit without closing anything. |

## Dispatch

- Mode `default` or `force`: invoke the `close-run` skill with the current mode (`default` or `force`), forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).

## 0. Help shortcut

**Run only when mode is `help`.**

If mode is `help`, print the block below verbatim and exit. No reads, no writes.

> `/dev-flows:close` winds down a branch whose work is being abandoned. Invoking it is the confirmation.
>
> Modes:
>   - (no arg) -- close what applies, below
>   - `force` -- the same, unattended (a workspace teardown script): asks nothing
>   - `help` -- show this and exit
>
> What it does, each only when it applies:
>   - closes the pull request
>   - deletes the remote branch
>   - cancels the issue the branch names (left open when another open pull request is attached to it)
>   - when the branch names no issue, searches for it and asks which one, if any, to cancel or mark done
>   - runs the repo's teardown (`close.after` hooks)
>
> It never deletes the local branch, switches branches, or touches the working tree. It refuses on the base branch, on a branch other branches are stacked on, and on a pull request that merged.

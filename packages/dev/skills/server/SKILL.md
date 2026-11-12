---
description: Start this worktree's dev server in the background when it isn't running, stop it, list the ones running across the repo's worktrees, or put one started by hand under a watchdog that stops it once its worktree is deleted or nobody uses it.
argument-hint: "[adopt|stop|list|help]"
---

# /dev-flows:server

Owns a worktree's dev server, from start to stop, so other commands don't have to: `/dev-flows:preview` runs this to get a server to open a page on, and `/dev-flows:finish` and `/dev-flows:cancel` stop it once the work is over.

The server it starts (`server.command` from the config) runs in the background, its output in a log in the repo's git dir, and goes on running after this ends, for the person to keep using. It doesn't run forever: a watchdog stops it once its worktree is deleted, or once nothing has been connected to it (no page open on it) for `server.idleTimeout` minutes (4 hours by default). The servers it starts are recorded for the whole repo, so every run also stops any left by a deleted worktree. It never edits the working tree, commits, or pushes.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `hooks.ts <subcommand>` | `run <point>... --flow <flow>` runs the repo's hooks at those points, in order, and prints what to do next: `done`, a task for you (`agent`), a failure that stops the command (`stop`), or a hook still running (`running`) |
| `server.ts <subcommand>` | `start [--command <cmd>] [--url <url>]` finds the dev server this checkout runs, or starts one in the background and waits until it answers, and prints its `status` and `url`; `stop [--all]` stops the one it started in this worktree (every one in this repo's worktrees with `--all`); `list` prints the ones it started; `adopt [--pid <pid>] [--command <cmd>]` restarts this checkout's unwatched server under the watchdog. Each first stops the servers it started for worktrees that are gone (`reaped`) |

## Invariants

- **Only this checkout's server.** Never stop or restart a server this command didn't start without the person's say-so, and never one of another checkout, except one it started for a worktree that's gone (the command stops those itself) or every one it started, when the person asks with `stop all`.
- **When another command runs this one** (`/dev-flows:preview`), end with the server's `url` and how it got there, for that command to go on with, rather than a report of your own, and ask nothing it can't answer: a question this asks the person is still asked, but a stop is that command's stop.
- **Run the repo's hooks around this command.** Skip this when the mode is `help`, or when another dev-flows command is running this one (it runs its own). Once the mode is known, before the first step's work: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run before --flow server --mode <mode>`. When the command ends, finished or stopped, just before its report or before telling the user why it stopped: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run after --flow server --mode <mode> --outcome <success, when it did its job, else failure>`, leaving out a flag whose value isn't known yet. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest (with `agent.recheck`, that first runs the hook's check again, and it fails like any check when the task didn't satisfy it); a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). `running`: a hook was still running when `--max-wait` ran out, and goes on running: run the same command again with `--wait <running.resume>` in place of any `--after`, until the status is another one, relaying `running.name` and how long it has run. When the host limits how long one command runs, add `--max-wait <a bit under that limit, in seconds>` to every `hooks.ts run`. An exit of 2 means bad arguments or an invalid config: relay its message and stop. At the end, a `stop` can't happen: report the `failures`. Say in the report which hooks ran at each point, what any task for you changed, and what failed.

## Modes

Read `$ARGUMENTS` first. If its first token is exactly one of the mode names below, run that mode. Otherwise, when this skill documents how to route the remaining arguments (see its intro), follow that; if it doesn't, run `default` and treat `$ARGUMENTS` as its input. Run only that mode's section below and skip the others.

| Mode | Trigger | What it does |
|------|---------|--------------|
| `default` | (no argument) | Make sure this worktree's dev server runs, starting it when it doesn't, and print where it serves. |
| `adopt` | `adopt` | The same, and restart a server started by hand under the watchdog without asking. |
| `stop` | `stop` | Stop the server started in this worktree; `stop all` stops every one started in the repo's worktrees. |
| `list` | `list` | List the servers started in the repo's worktrees. |
| `help` | `help` | Show usage and exit. |

## 0. Help shortcut

**Run only when mode is `help`.**

If the argument is `help`, print the block below verbatim and stop.

```
/dev-flows:server  [adopt | stop [all] | list | help]

Starts this worktree's dev server when it isn't running (server.command, in
the background, its output in a log in the git dir) and prints where it
serves. A watchdog stops it once the worktree is deleted, or after
server.idleTimeout minutes (default 240) with nothing connected to it.

adopt: restart a server started by hand under the watchdog, without asking
stop: stops the dev server started in this worktree
stop all: stops every dev server started in this repo's worktrees
list: the dev servers started in this repo's worktrees

Every run also stops the servers started for worktrees that are gone, and
finish and cancel stop this worktree's.
```

## 1. Stop

**Run only when mode is `stop`.**

Run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/server.ts" stop`, or with the argument `all`, `node "${CLAUDE_PLUGIN_ROOT}/src/commands/server.ts" stop --all`. It prints `stopped` (each server it stopped: its `worktree`, `pid`, and `command`), a `reason` when it stopped none, and `reaped` (servers whose worktree is gone, stopped too): say which, and end here. It stops only servers this command started; for one the person started by hand, say so, and leave it.

## 2. List

**Run only when mode is `list`.**

Run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/server.ts" list`. It prints `servers`, each with its `worktree` (`here` for this one), `url`, `pid`, `command`, and `startedAt`, and `reaped`. Show them as a short table, name any `reaped`, say `/dev-flows:server stop all` stops them, and end here.

## 3. Start

**Run only when mode is `default` or `adopt`.**

Run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/server.ts" start`. It reads `server.command`, `server.url`, `server.timeout`, and `server.idleTimeout` from the config itself, and works on a repo that isn't configured too. It prints JSON with a `status` and a `url`, `servers` (the processes of this checkout listening for connections, each with its `pid`, `port`, and `command`), `ours` (whether this command started the server), `watched` (whether it runs under the watchdog), and `reaped` (servers it started for worktrees that are gone, stopped now):

- `running`: a server of this checkout's answers at `url`. With `url` `null`, it runs several: the one serving the app's pages is `<url>` (`http://localhost:<its port>`), by its `command` (the web app's dev server, not an API, a worker, a database, or a component explorer). When none clearly is, ask the person which, with `AskUserQuestion` listing them.
- `started`: it started `command` now (`pid`, its output in `log`), and it answers at `url`.
- `unconfigured`: nothing runs, and the config sets no `server.command`. Find how this repo starts its dev server: a `dev` script in its package manifest (at the root, or in the app the branch changes, in a monorepo), its README, `CLAUDE.md` or `AGENTS.md`, a `Procfile`, a `Makefile`, or a compose file. When one command clearly does it, run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/server.ts" start --command '<it>'`, and say that `/dev-flows:configure server` saves it. When it isn't clear, ask the person. When the repo has no dev server (a library, a CLI), say so and end here.
- `elsewhere`: the configured `url` answers, but another checkout's server serves it (`owner`: its `pid`, `cwd`, and `command`), so it serves that checkout's work, not this one's. Ask the person, with `AskUserQuestion` naming `owner.cwd`: stop that server (`kill <owner.pid>`, then run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/server.ts" start` again to start this checkout's), use it anyway (knowing it isn't this branch's work), or stop here.
- `failed`: the command exited before it answered (`exitCode`, its last lines in `tail`, all of it in `log`). Show the person `tail` and `log`, and end here. When the failure comes from this branch's own change (a compile error in a file it touched), say so, and which file; fix nothing.
- `timeout`: it still hadn't answered after `server.timeout` seconds, and goes on running. Show `tail` and `log`; when the output shows it's still building, run the same command once more (it finds the server it started and waits again), else end here.

### An unwatched server

When it's `running` with `watched` false, and the server it found is this checkout's (`ours` true, or one of `servers`), nothing will stop it when its worktree is deleted or it sits idle: someone started it by hand, or an older dev-flows did. In `adopt` mode, restart it; otherwise ask the person, with `AskUserQuestion` naming its `command` and `pid`: restart it under the watchdog (it stops, then starts again: what it holds in memory is lost, and a terminal it ran in shows it exited), or leave it as it is.

To restart: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/server.ts" adopt --pid <the pid of the process listening on <url>'s port, from `servers`> --command '<it>'`, with `--url <url>` when the config sets no `server.url`. `<it>` is `server.command` when the config sets one (leave `--command` out), else the command found as for `unconfigured` (ask when it isn't clear; with none, leave the server as it is). For one an older dev-flows started (`ours` true), leave `--pid` out. It prints what `start` prints for `started`, `failed`, or `timeout`, handled the same way, plus `replaced`, the server it stopped. A `failed` with a `reason` stopped nothing (it won't stop a shell, or anything this session runs under): say why, and go on with the server as it is.

### Report

A few lines, or, when another command runs this one, only what it goes on with:

- **Server:** `<url>`; started now (`pid`, `log`), restarted under the watchdog (what `replaced` was), or already running (whose: this command's, or one started by hand). Whether the watchdog watches it (stopped once the worktree is deleted, or after `server.idleTimeout` minutes with nothing connected), or it was left unwatched. `/dev-flows:server stop` stops one this command started (as `/dev-flows:finish` and `/dev-flows:cancel` do). When the command came from the repo rather than the config: `/dev-flows:configure server` saves it.
- **Reaped:** the servers it stopped because their worktree is gone, by worktree, when there are any.

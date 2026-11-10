---
description: Start the repo's dev server when it isn't running and open the page the current work changed in a browser: the workspace app's own, else this session's browser tools, else the system's. Also stops the server it started.
argument-hint: "[<page path, URL, or description> | stop | help]"
---

# /dev-flows:preview

Shows the person what this branch's work looks like, running: it makes sure this checkout's dev server is up (starting it in the background when it isn't, with `preview.command` from the config), works out which page the work changed, and opens it. It opens in the browser of the workspace app this session runs in, beside the agent, when the repo configured one (`/dev-flows:configure browser`); else with this session's own browser tools; else in the system's default browser.

It never edits the working tree, commits, or pushes. The server it starts goes on running after it ends, for the person to keep using: `/dev-flows:preview stop` stops it.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `hooks.ts <subcommand>` | `run <point>... --flow <flow>` runs the repo's hooks at those points, in order, and prints what to do next: `done`, a task for you (`agent`), a failure that stops the command (`stop`), or a hook still running (`running`) |
| `configure.ts <subcommand>` | `get <path>... [--optional]` prints configured values (`null` for an unset one with `--optional`); `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Both exit 2 when the repo isn't configured for what's asked |
| `preview.ts <subcommand>` | `server [--command <cmd>] [--url <url>] [--check]` finds the dev server this checkout runs, or starts one in the background and waits until it answers, and prints its `status` and `url`; `stop` stops the server preview started in this worktree |

## Invariants

- **Only this checkout's server.** Open a page only from a server this checkout runs. Never stop or restart a server preview didn't start without the person's say-so, and never one of another checkout.
- **Run the repo's hooks around this command.** Skip this when the mode is `help`, or when another dev-flows command is running this one (it runs its own). Once the mode is known, before the first step's work: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run before --flow preview --mode <mode>`. When the command ends, finished or stopped, just before its report or before telling the user why it stopped: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run after --flow preview --mode <mode> --outcome <success, when it did its job, else failure>`, leaving out a flag whose value isn't known yet. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest (with `agent.recheck`, that first runs the hook's check again, and it fails like any check when the task didn't satisfy it); a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). `running`: a hook was still running when `--max-wait` ran out, and goes on running: run the same command again with `--wait <running.resume>` in place of any `--after`, until the status is another one, relaying `running.name` and how long it has run. When the host limits how long one command runs, add `--max-wait <a bit under that limit, in seconds>` to every `hooks.ts run`. An exit of 2 means bad arguments or an invalid config: relay its message and stop. At the end, a `stop` can't happen: report the `failures`. Say in the report which hooks ran at each point, what any task for you changed, and what failed.

## Modes

Read `$ARGUMENTS` first. If its first token is exactly one of the mode names below, run that mode. Otherwise, when this skill documents how to route the remaining arguments (see its intro), follow that; if it doesn't, run `default` and treat `$ARGUMENTS` as its input. Run only that mode's section below and skip the others.

| Mode | Trigger | What it does |
|------|---------|--------------|
| `default` | (no argument) | Make sure the dev server runs, then open the page the work changed. |
| `help` | `help` | Show usage and exit. |

## 0. Help shortcut

**Run only when mode is `help`.**

If the argument is `help`, print the block below verbatim and stop.

```
/dev-flows:preview  [<page> | stop | help]

Starts this checkout's dev server when it isn't running (preview.command,
in the background, its output in a log in the git dir), then opens the
page the current work changed: in the workspace app's browser beside this
session, else with this session's browser tools, else in the system's
default browser.

<page>: what to open instead of the page the work changed: a path
  (/settings/billing), a full URL, or words (the billing settings page)
stop: stops the dev server preview started in this worktree
```

## 1. The dev server

**`stop`:** when the argument is `stop`, run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/preview.ts" stop`. It prints `stopped` (with the `pid` it stopped) or a `reason` none was: say which, and end here. It stops only a server preview started; for one the person started by hand, say so, and leave it.

Otherwise, the argument, if any, is `<page>`.

Run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/preview.ts" server`. It reads `preview.command`, `preview.url`, and `preview.timeout` from the config itself, and works on a repo that isn't configured too. It prints JSON with a `status` and a `url`, `servers` (the processes of this checkout listening for connections, each with its `pid`, `port`, and `command`), and `ours` (whether preview started the server):

- `running`: a server of this checkout's answers at `url`. Go on. With `url` `null`, it runs several: the one serving the app's pages is `<url>` (`http://localhost:<its port>`), by its `command` (the web app's dev server, not an API, a worker, a database, or a component explorer). When none clearly is, ask the person which, with `AskUserQuestion` listing them.
- `started`: it started `command` now (`pid`, its output in `log`), and it answers at `url`. Go on.
- `unconfigured`: nothing runs, and the config sets no `preview.command`. Find how this repo starts its dev server: a `dev` script in its package manifest (at the root, or in the app the branch changes, in a monorepo), its README, `CLAUDE.md` or `AGENTS.md`, a `Procfile`, a `Makefile`, or a compose file. When one command clearly does it, run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/preview.ts" server --command '<it>'`, and say in the report that `/dev-flows:configure preview` saves it. When it isn't clear, ask the person. When the repo has no web app to show (a library, a CLI), say so and end here.
- `elsewhere`: the configured `url` answers, but another checkout's server serves it (`owner`: its `pid`, `cwd`, and `command`), so it shows that checkout's work, not this one's. Ask the person, with `AskUserQuestion` naming `owner.cwd`: stop that server (`kill <owner.pid>`, then run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/preview.ts" server` again to start this checkout's), open it anyway (knowing it isn't this branch's work), or stop here.
- `failed`: the command exited before it answered (`exitCode`, its last lines in `tail`, all of it in `log`). Show the person `tail` and `log`, and end here. When the failure comes from this branch's own change (a compile error in a file it touched), say so, and which file; fix nothing.
- `timeout`: it still hadn't answered after `preview.timeout` seconds, and goes on running. Show `tail` and `log`; when the output shows it's still building, run the same command once more (it finds the server it started and waits again), else end here.

## 2. The page

Work out `<target>`, the full URL to open, on the server's `<url>`:

1. **`<page>` given:** a full URL is `<target>` as it is (on another host, ask first: it isn't this checkout's server). A path is `<url>`'s origin plus that path. Words name a page: find the route that renders it, as in 3.
2. **This session's work:** with no `<page>`, the page this session has been working on, when the conversation makes it plain (a route it built, a component the person asked about, a page it was told to change). It takes in uncommitted work, which a diff of the commits alone would miss.
3. **The branch's changes:** otherwise, the files the branch changes: `git diff --name-only $(git merge-base <base-ref> HEAD)` plus `git ls-files --others --exclude-standard`. `<base-ref>` is `origin/<base>` for the base branch `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" get repo.baseBranch` prints (or, when that exits 2, `git symbolic-ref --short refs/remotes/origin/HEAD`). Map them to routes by the framework's own conventions: a file-based router's page and layout files (`app/`, `pages/`, `routes/`, `src/routes/`, `src/pages/`), or the routes table a server framework keeps (a `urls.py`, a `routes.rb`, a router module). A changed component, hook, or style counts through the pages that use it: follow its importers up to the nearest page. Prefer the page the change is most about: the one it adds, else the one with the most of its change.

A route with dynamic segments (`[id]`, `:slug`) needs real values: take them from the session's work, the repo's seed data or fixtures, or a link on the parent page that already answers. When none turns up, use the nearest page without one, and say so. With no page in the change (a back-end change, a config change), `<target>` is `<url>`, and say which change it serves.

Check it before opening: `curl -s -o /dev/null -w '%{http_code}' <target>`. A 404 means the route was read wrong: look again, once. A 5xx is the page failing: open it anyway (its error is worth seeing), and give the server's log or output in the report. A redirect to a sign-in page is fine: say the person may need to sign in.

Keep the other pages the change touches, their URLs, for the report.

## 3. Open it

Open `<target>` in the first of these that works, saying in the report which:

1. **The workspace app's browser.** `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations workspaces browser --optional` (when it exits 2, the repo isn't configured: skip to 2). Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `script` (an adapter: the op as code, built in or the repo's own; run it, and when it exits 3 it can't run here, so go on to the next), `mcp` when this session has tools from an MCP server whose name contains `access.mcp.server` (tools that are deferred, or from a server still connecting, count: search for them with your tool search before deciding they're missing), `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Whether a way works is settled by using it, not only by how it looks: when the chosen variant fails because of the way in (the MCP server errors, disconnects, times out, or asks to sign in; the CLI says it isn't signed in or can't connect; the API answers 401, 403, 429, or 5xx, or doesn't answer), go on to the next variant the op lists, and say in the report which way failed and which one did the work. A failure from the integration itself (not found, a rejected value, a conflict, a permission the account lacks on that item) isn't one: the next way would fail the same, so handle it as the op says. Before falling back from a variant that writes (creates, updates, comments, merges), check with the op's read, or the integration's, whether the write landed anyway, so the next way doesn't do it twice. Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. An op given as `unsupported` is one that integration has nothing for: skip what needs it, and say so in the report with its reason. Run the chosen variant as given rather than a tool you know. When no variant of an op works, having tried each whose way looked available, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them. Only a `browser` entry this session runs in counts (`"here": true`): a browser beside another workspace is no use to the person here. With one, find this session's workspace: the `workspaces` op of the `workspaces` entry of the same integration, the workspace it marks as this session's, its id `<workspace>`. Then that `browser` entry's `openUrl` op, with `<url>` `<target>`, `<origin>` its scheme, host, and port (`http://localhost:3000`), and `<workspace>`. When there's no such entry, or no way of the op works, go on to 2.
2. **This session's browser tools.** When this session has tools that drive a browser (a built-in one, or a browser extension's; deferred tools count: search for them before deciding there are none), open `<target>` in a new tab with them, so you can see the page too.
3. **The system's default browser.** `open '<target>'` on macOS, `xdg-open '<target>'` on Linux, `start "" "<target>"` on Windows. Skip it when there's no display to open one on (a remote shell, a container, CI).

When none works, give the person `<target>` to open themselves.

## 4. Report

A few lines:

- **Opened:** `<target>`, and where (the workspace app's browser, this session's browser tools, the system's browser, or not opened), with why it's the page: the change it shows. Any trouble `curl` found (a 5xx and the log lines behind it, a sign-in).
- **Server:** started now (`pid`, `log`) or already running (whose: preview's, or one started by hand), and its `url`. When preview started it: `/dev-flows:preview stop` stops it. When the command came from the repo rather than the config: `/dev-flows:configure preview` saves it.
- **Also changed:** the other pages the change touches, as URLs, when there are any.

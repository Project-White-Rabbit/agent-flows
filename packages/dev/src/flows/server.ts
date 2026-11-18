import type { Flow } from "@agent-flows/core"
import { DEV_COMMANDS, devKit, HOOKS_COMMAND, hooksInvariant } from "./kit.ts"

/** The `server` command entry, for a flow that only stops this worktree's. */
export const SERVER_STOP_COMMAND = {
  description:
    "`stop` stops the dev server these commands started in this worktree, if any (with `server.up`, through the repo's manager's `server.down`), and prints what it stopped (with what the repo's `server.stopped` hooks did, as `hooks`)",
  args: "<subcommand>",
}

export const serverFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "server",
  title: "{{cmd}}server",
  frontmatter: {
    description:
      "Start this worktree's dev server in the background when it isn't running, stop it, list the ones running across the repo's worktrees, or put one started by hand under a watchdog that stops it once its worktree is deleted or nobody uses it.",
    argumentHint: { deriveFromModes: true },
  },
  commands: DEV_COMMANDS.defineCommands({
    hooks: HOOKS_COMMAND,
    server: {
      description:
        "`start [--command <cmd>] [--url <url>]` finds the dev server this checkout runs, or starts one in the background and waits until it answers, and prints its `status` and `url`; `restart` stops it and starts it again; `stop [--all]` stops the one it started in this worktree (every one in this repo's worktrees with `--all`); `list` prints the ones it started; `adopt [--pid <pid>] [--command <cmd>]` restarts this checkout's unwatched server under the watchdog. `--branch <branch>` makes any of them work on the server of the worktree that has that branch checked out (with `server.up` and no such worktree, the manager's commands get the branch alone). Each first stops the servers it started for worktrees that are gone (`reaped`). With `server.up`, each runs the repo's own server manager's commands instead, and prints `managed`",
      args: "<subcommand>",
    },
  }),
  tools: {},
  compile: { mode: { default: "monolith" }, inlinePhases: [] },
  entries: {
    default: "main/start",
    up: "main/start",
    adopt: "main/start",
    restart: "main/start",
    stop: "main/stop",
    down: "main/stop",
    list: "main/list",
    status: "main/list",
    help: "main/help",
  },
  defaultMode: "default",
  modeHints: {
    default:
      "Make sure this worktree's dev server runs, starting it when it doesn't, and print where it serves.",
    up: "The same as `default`.",
    adopt:
      "The same, and restart a server started by hand under the watchdog without asking.",
    restart: "Stop this worktree's dev server, if it runs, and start it again.",
    stop: "Stop the server started in this worktree; `stop all` stops every one started in the repo's worktrees.",
    down: "The same as `stop`.",
    list: "List the servers started in the repo's worktrees.",
    status: "The same as `list`.",
    help: "Show usage and exit.",
  },
  intro: `Owns a worktree's dev server, from start to stop, so other commands don't have to: \`{{cmd}}preview\` runs this to get a server to open a page on, and \`{{cmd}}finish\` and \`{{cmd}}cancel\` stop it once the work is over.

The server it starts (\`server.command\` from the config) runs in the background, its output in a log in the repo's git dir, and goes on running after this ends, for the person to keep using. It doesn't run forever: a watchdog stops it once its worktree is deleted, or once nothing has been connected to it (no page open on it) for \`server.idleTimeout\` minutes (4 hours by default). The servers it starts are recorded for the whole repo, so every run also stops any left by a deleted worktree. It never edits the working tree, commits, or pushes.

A repo whose servers a manager of its own runs (a daemon or script that starts them in the background) sets \`server.up\` instead of \`server.command\`, and \`server.down\`, \`server.restart\`, \`server.status\`, and \`server.list\` as it has them: then the command runs those, prints \`managed\`, and runs no watchdog, since the manager decides when its servers stop. \`up\`, \`down\`, and \`status\` are other names for \`default\`, \`stop\`, and \`list\`, for a front end that used them.

A branch name after the mode (\`up feature/x\`, \`restart feature/x\`, \`stop feature/x\`, \`status feature/x\`) works on that branch's server instead of this worktree's: the one of the worktree that has it checked out, or, with \`server.up\` and no worktree holding it, the one the repo's manager runs for it. Pass it as \`--branch <branch>\` to every \`{{command:server}}\` call below; without \`server.up\`, a branch no worktree holds is an error to relay.`,
  invariants: [
    "**Only this checkout's server.** Never stop or restart a server this command didn't start without the person's say-so, and never one of another checkout, except one it started for a worktree that's gone (the command stops those itself) or every one it started, when the person asks with `stop all`.",
    "**When another command runs this one** (`{{cmd}}preview`), end with the server's `url` and how it got there, for that command to go on with, rather than a report of your own, and ask nothing it can't answer: a question this asks the person is still asked, but a stop is that command's stop.",
    hooksInvariant("server"),
  ],
  phases: [
    {
      id: "main",
      title: "Main",
      stepStyle: "headers",
      steps: [
        {
          id: "help",
          kind: "action",
          title: "Help shortcut",
          preamble: true,
          body: `If the argument is \`help\`, print the block below verbatim and stop.

\`\`\`
{{cmd}}server  [up | restart | adopt | stop [all] | down | list | status | help] [<branch>]

Starts this worktree's dev server when it isn't running (server.command, in
the background, its output in a log in the git dir) and prints where it
serves. A watchdog stops it once the worktree is deleted, or after
server.idleTimeout minutes (default 240) with nothing connected to it.

up: the same as no argument
restart: stops this worktree's dev server, if it runs, and starts it again
adopt: restart a server started by hand under the watchdog, without asking
stop (or down): stops the dev server started in this worktree
stop all: stops every dev server started in this repo's worktrees
list (or status): the dev servers started in this repo's worktrees
<branch> after any of them: that branch's server, from the worktree that has
it checked out (with server.up, the manager's, for any branch)

With server.up, the repo's own manager runs its servers: these run its
commands (server.up, server.restart, server.down, server.list) instead, and
no watchdog stops them.

Every run also stops the servers started for worktrees that are gone, and
finish and cancel stop this worktree's.
\`\`\``,
          next: null,
        },
        {
          id: "stop",
          kind: "action",
          title: "Stop",
          commandCalls: ["server"],
          body: `Run \`{{command:server}} stop\`, or with the argument \`all\`, \`{{command:server}} stop --all\`. It prints \`stopped\` (each server it stopped: its \`worktree\`, \`pid\`, \`command\`, and \`hooks\`, what the repo's \`server.stopped\` hooks did for it, which it runs itself), a \`reason\` when it stopped none, and \`reaped\` (servers whose worktree is gone, stopped too): say which, name any hook in \`hooks.failures\`, and end here. It stops only servers this command started; for one the person started by hand, say so, and leave it. With \`managed\`, it ran the manager's \`server.down\` for this worktree (its \`command\` in \`stopped\`, what it printed in \`output\`): a \`reason\` says why it stopped nothing (\`server.down\` failed, or isn't set, or \`all\`, which is the manager's to do).`,
          next: null,
        },
        {
          id: "list",
          kind: "action",
          title: "List",
          commandCalls: ["server"],
          body: `Run \`{{command:server}} list\`. It prints \`servers\`, each with its \`worktree\` (\`here\` for this one), \`url\`, \`pid\`, \`command\`, and \`startedAt\`, and \`reaped\`. Show them as a short table, name any \`reaped\`, say \`{{cmd}}server stop all\` stops them, and end here. With \`managed\`, \`output\` is what the manager's \`server.list\` printed (\`null\` when it isn't set, with a \`reason\` when it failed): show it as it is, after the table (or alone, when \`servers\` is empty), and leave out \`stop all\`.`,
          next: null,
        },
        {
          id: "start",
          kind: "action",
          title: "Start",
          commandCalls: ["server"],
          body: `Run \`{{command:server}} start\` (in \`restart\` mode, \`{{command:server}} restart\`, which first stops this worktree's server, if one it started runs, and prints what it stopped as \`replaced\`; the rest is the same). It reads \`server.command\`, \`server.url\`, \`server.ports\`, \`server.timeout\`, \`server.idleTimeout\`, and the manager's commands (\`server.up\` and the rest) from the config itself, and works on a repo that isn't configured too. It prints JSON with a \`status\` and a \`url\`, \`servers\` (the processes of this checkout listening for connections, each with its \`pid\`, \`port\`, and \`command\`), \`ours\` (whether this command started the server), \`watched\` (whether it runs under the watchdog), \`port\` (the one \`server.ports\` gave it), \`hooks\` (what the repo's \`server.started\` hooks did, which it runs itself each time a server it started answers: \`ran\` and \`failures\`), and \`reaped\` (servers it started for worktrees that are gone, stopped now). A \`failed\` with a \`reason\` and no \`log\` started nothing (every port in \`server.ports\` is in use): say so, and end here:

- \`running\`: a server of this checkout's answers at \`url\`. With \`url\` \`null\`, it runs several: the one serving the app's pages is \`<url>\` (\`http://localhost:<its port>\`), by its \`command\` (the web app's dev server, not an API, a worker, a database, or a component explorer). When none clearly is, ask the person which, {{askUser}}listing them.
- \`started\`: it started \`command\` now (\`pid\`, its output in \`log\`), and it answers at \`url\`.
- \`unconfigured\`: nothing runs, and the config sets no \`server.command\` (or \`server.up\`). Find how this repo starts its dev server: a \`dev\` script in its package manifest (at the root, or in the app the branch changes, in a monorepo), its README, \`CLAUDE.md\` or \`AGENTS.md\`, a \`Procfile\`, a \`Makefile\`, or a compose file. When one command clearly does it, run \`{{command:server}} start --command '<it>'\`, and say that \`{{cmd}}configure server\` saves it. When the repo starts its servers through a manager of its own (a command that starts them in the background and returns, with others to stop and list them), don't run it here: say that \`{{cmd}}configure server\` saves its commands as \`server.up\`, \`server.down\`, and the rest, and end here. When it isn't clear, ask the person. When the repo has no dev server (a library, a CLI), say so and end here.
- \`elsewhere\`: the configured \`url\` answers, but another checkout's server serves it (\`owner\`: its \`pid\`, \`cwd\`, and \`command\`), so it serves that checkout's work, not this one's. Ask the person, {{askUser}}naming \`owner.cwd\`: stop that server (\`kill <owner.pid>\`, then run \`{{command:server}} start\` again to start this checkout's), use it anyway (knowing it isn't this branch's work), or stop here.
- \`failed\`: the command exited before it answered (\`exitCode\`, its last lines in \`tail\`, all of it in \`log\`). Show the person \`tail\` and \`log\`, and end here. When the failure comes from this branch's own change (a compile error in a file it touched), say so, and which file; fix nothing.
- \`timeout\`: it still hadn't answered after \`server.timeout\` seconds, and goes on running. Show \`tail\` and \`log\`; when the output shows it's still building, run the same command once more (it finds the server it started and waits again), else end here.

### A manager's server

With \`managed\` true, the repo's own manager runs the server (\`server.up\`): \`running\` means \`server.status\` printed a URL that answers; \`started\` means the manager's \`command\` (\`server.up\`, or for \`restart\`, \`server.restart\`) ran now and \`url\` answers, with what it printed in \`log\`; \`failed\` means that command exited non-zero (\`exitCode\`, \`tail\`), or, with a \`reason\`, its URL can't be known (say what to set: \`server.status\`, \`server.url\`, or \`server.ports\`); \`timeout\` is as above. \`servers\` is empty, \`pid\` is never given, and nothing is unwatched: the manager decides when it stops, so skip the next section.

### An unwatched server

When it's \`running\` with \`watched\` false and no \`managed\`, and the server it found is this checkout's (\`ours\` true, or one of \`servers\`), nothing will stop it when its worktree is deleted or it sits idle: someone started it by hand, or an older version of these commands did. In \`adopt\` mode, restart it; otherwise ask the person, {{askUser}}naming its \`command\` and \`pid\`: restart it under the watchdog (it stops, then starts again: what it holds in memory is lost, and a terminal it ran in shows it exited), or leave it as it is.

To restart: \`{{command:server}} adopt --pid <the pid of the process listening on <url>'s port, from \`servers\`> --command '<it>'\`, with \`--url <url>\` when the config sets no \`server.url\`. \`<it>\` is \`server.command\` when the config sets one (leave \`--command\` out), else the command found as for \`unconfigured\` (ask when it isn't clear; with none, leave the server as it is). For one an older version started (\`ours\` true), leave \`--pid\` out. It prints what \`start\` prints for \`started\`, \`failed\`, or \`timeout\`, handled the same way, plus \`replaced\`, the server it stopped. A \`failed\` with a \`reason\` stopped nothing (it won't stop a shell, or anything this session runs under): say why, and go on with the server as it is.

### Report

A few lines, or, when another command runs this one, only what it goes on with:

- **Server:** \`<url>\`; started now (\`pid\`, \`log\`), restarted under the watchdog (what \`replaced\` was), or already running (whose: this command's, or one started by hand). Whether the watchdog watches it (stopped once the worktree is deleted, or after \`server.idleTimeout\` minutes with nothing connected), or it was left unwatched; for a \`managed\` one, that the repo's manager runs it instead. \`{{cmd}}server stop\` stops one this command started (for a \`managed\` one, through \`server.down\`) (as \`{{cmd}}finish\` and \`{{cmd}}cancel\` do). When the command came from the repo rather than the config: \`{{cmd}}configure server\` saves it.
- **Reaped:** the servers it stopped because their worktree is gone, by worktree, when there are any.
- **Server hooks:** when \`hooks\` lists any, which of the repo's \`server.started\` hooks ran, and any that failed (\`hooks.failures\`: their \`name\` and \`output\`); a failure doesn't stop the server.`,
          next: null,
        },
      ],
    },
  ],
})

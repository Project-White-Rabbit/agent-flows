import type { Flow } from "@agent-flows/core"
import {
  CONFIGURE_GET_AND_INTEGRATIONS,
  DEV_COMMANDS,
  devKit,
  HOOK_RESULTS,
  HOOKS_COMMAND,
  hooksInvariant,
  USE_INTEGRATIONS,
} from "./kit.ts"

export const previewFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "preview",
  title: "{{cmd}}preview",
  frontmatter: {
    description:
      "Start the repo's dev server when it isn't running and open the page the current work changed in a browser: the workspace app's own, else this session's browser tools, else the system's. Also stops the server it started.",
    argumentHint: "[<page path, URL, or description> | stop | help]",
  },
  commands: DEV_COMMANDS.defineCommands({
    hooks: HOOKS_COMMAND,
    configure: CONFIGURE_GET_AND_INTEGRATIONS,
    preview: {
      description:
        "`server [--command <cmd>] [--url <url>] [--check]` finds the dev server this checkout runs, or starts one in the background and waits until it answers, and prints its `status` and `url`; `stop` stops the server preview started in this worktree",
      args: "<subcommand>",
    },
  }),
  tools: {},
  compile: { mode: { default: "monolith" }, inlinePhases: [] },
  entries: { default: "main/server", help: "main/help" },
  defaultMode: "default",
  modeHints: {
    default:
      "Make sure the dev server runs, then open the page the work changed.",
    help: "Show usage and exit.",
  },
  intro: `Shows the person what this branch's work looks like, running: it makes sure this checkout's dev server is up (starting it in the background when it isn't, with \`preview.command\` from the config), works out which page the work changed, and opens it. It opens in the browser of the workspace app this session runs in, beside the agent, when the repo configured one (\`{{cmd}}configure browser\`); else with this session's own browser tools; else in the system's default browser.

It never edits the working tree, commits, or pushes. The server it starts goes on running after it ends, for the person to keep using: \`{{cmd}}preview stop\` stops it.`,
  invariants: [
    "**Only this checkout's server.** Open a page only from a server this checkout runs. Never stop or restart a server preview didn't start without the person's say-so, and never one of another checkout.",
    hooksInvariant("preview"),
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
{{cmd}}preview  [<page> | stop | help]

Starts this checkout's dev server when it isn't running (preview.command,
in the background, its output in a log in the git dir), then opens the
page the current work changed: in the workspace app's browser beside this
session, else with this session's browser tools, else in the system's
default browser.

<page>: what to open instead of the page the work changed: a path
  (/settings/billing), a full URL, or words (the billing settings page)
stop: stops the dev server preview started in this worktree
\`\`\``,
          next: "main/server",
        },
        {
          id: "server",
          kind: "action",
          title: "The dev server",
          commandCalls: ["preview"],
          body: `**\`stop\`:** when the argument is \`stop\`, run \`{{command:preview}} stop\`. It prints \`stopped\` (with the \`pid\` it stopped) or a \`reason\` none was: say which, and end here. It stops only a server preview started; for one the person started by hand, say so, and leave it.

Otherwise, the argument, if any, is \`<page>\`.

Run \`{{command:preview}} server\`. It reads \`preview.command\`, \`preview.url\`, and \`preview.timeout\` from the config itself, and works on a repo that isn't configured too. It prints JSON with a \`status\` and a \`url\`, \`servers\` (the processes of this checkout listening for connections, each with its \`pid\`, \`port\`, and \`command\`), and \`ours\` (whether preview started the server):

- \`running\`: a server of this checkout's answers at \`url\`. Go on. With \`url\` \`null\`, it runs several: the one serving the app's pages is \`<url>\` (\`http://localhost:<its port>\`), by its \`command\` (the web app's dev server, not an API, a worker, a database, or a component explorer). When none clearly is, ask the person which, {{askUser}}listing them.
- \`started\`: it started \`command\` now (\`pid\`, its output in \`log\`), and it answers at \`url\`. Go on.
- \`unconfigured\`: nothing runs, and the config sets no \`preview.command\`. Find how this repo starts its dev server: a \`dev\` script in its package manifest (at the root, or in the app the branch changes, in a monorepo), its README, \`CLAUDE.md\` or \`AGENTS.md\`, a \`Procfile\`, a \`Makefile\`, or a compose file. When one command clearly does it, run \`{{command:preview}} server --command '<it>'\`, and say in the report that \`{{cmd}}configure preview\` saves it. When it isn't clear, ask the person. When the repo has no web app to show (a library, a CLI), say so and end here.
- \`elsewhere\`: the configured \`url\` answers, but another checkout's server serves it (\`owner\`: its \`pid\`, \`cwd\`, and \`command\`), so it shows that checkout's work, not this one's. Ask the person, {{askUser}}naming \`owner.cwd\`: stop that server (\`kill <owner.pid>\`, then run \`{{command:preview}} server\` again to start this checkout's), open it anyway (knowing it isn't this branch's work), or stop here.
- \`failed\`: the command exited before it answered (\`exitCode\`, its last lines in \`tail\`, all of it in \`log\`). Show the person \`tail\` and \`log\`, and end here. When the failure comes from this branch's own change (a compile error in a file it touched), say so, and which file; fix nothing.
- \`timeout\`: it still hadn't answered after \`preview.timeout\` seconds, and goes on running. Show \`tail\` and \`log\`; when the output shows it's still building, run the same command once more (it finds the server it started and waits again), else end here.`,
          next: "main/page",
        },
        {
          id: "page",
          kind: "action",
          title: "The page",
          commandCalls: ["configure"],
          body: `Work out \`<target>\`, the full URL to open, on the server's \`<url>\`:

1. **\`<page>\` given:** a full URL is \`<target>\` as it is (on another host, ask first: it isn't this checkout's server). A path is \`<url>\`'s origin plus that path. Words name a page: find the route that renders it, as in 3.
2. **This session's work:** with no \`<page>\`, the page this session has been working on, when the conversation makes it plain (a route it built, a component the person asked about, a page it was told to change). It takes in uncommitted work, which a diff of the commits alone would miss.
3. **The branch's changes:** otherwise, the files the branch changes: \`git diff --name-only $(git merge-base <base-ref> HEAD)\` plus \`git ls-files --others --exclude-standard\`. \`<base-ref>\` is \`origin/<base>\` for the base branch \`{{command:configure}} get repo.baseBranch\` prints (or, when that exits 2, \`git symbolic-ref --short refs/remotes/origin/HEAD\`). Map them to routes by the framework's own conventions: a file-based router's page and layout files (\`app/\`, \`pages/\`, \`routes/\`, \`src/routes/\`, \`src/pages/\`), or the routes table a server framework keeps (a \`urls.py\`, a \`routes.rb\`, a router module). A changed component, hook, or style counts through the pages that use it: follow its importers up to the nearest page. Prefer the page the change is most about: the one it adds, else the one with the most of its change.

A route with dynamic segments (\`[id]\`, \`:slug\`) needs real values: take them from the session's work, the repo's seed data or fixtures, or a link on the parent page that already answers. When none turns up, use the nearest page without one, and say so. With no page in the change (a back-end change, a config change), \`<target>\` is \`<url>\`, and say which change it serves.

Check it before opening: \`curl -s -o /dev/null -w '%{http_code}' <target>\`. A 404 means the route was read wrong: look again, once. A 5xx is the page failing: open it anyway (its error is worth seeing), and give the server's log or output in the report. A redirect to a sign-in page is fine: a \`preview.afterOpen\` hook may get past it (step 4); else say the person may need to sign in.

Keep the other pages the change touches, their URLs, for the report.`,
          next: "main/open",
        },
        {
          id: "open",
          kind: "action",
          title: "Open it",
          commandCalls: ["configure"],
          body: `Open \`<target>\` in the first of these that works, saying in the report which:

1. **The workspace app's browser.** \`{{command:configure}} integrations workspaces browser --optional\` (when it exits 2, the repo isn't configured: skip to 2). ${USE_INTEGRATIONS} Only a \`browser\` entry this session runs in counts (\`"here": true\`): a browser beside another workspace is no use to the person here. With one, find this session's workspace: the \`workspaces\` op of the \`workspaces\` entry of the same integration, the workspace it marks as this session's, its id \`<workspace>\`. Then that \`browser\` entry's \`openUrl\` op, with \`<url>\` \`<target>\`, \`<origin>\` its scheme, host, and port (\`http://localhost:3000\`), and \`<workspace>\`. When there's no such entry, or no way of the op works, go on to 2.
2. **This session's browser tools.** When this session has tools that drive a browser (a built-in one, or a browser extension's; deferred tools count: search for them before deciding there are none), open \`<target>\` in a new tab with them, so you can see the page too.
3. **The system's default browser.** \`open '<target>'\` on macOS, \`xdg-open '<target>'\` on Linux, \`start "" "<target>"\` on Windows. Skip it when there's no display to open one on (a remote shell, a container, CI).

When none works, give the person \`<target>\` to open themselves.`,
          next: "main/after-open",
        },
        {
          id: "after-open",
          kind: "action",
          title: "The repo's steps on the page",
          commandCalls: ["hooks"],
          body: `Run \`{{command:hooks}} run preview.afterOpen --flow preview --mode <mode> --url <target>\`: the repo's own steps for getting the person onto the page (signing in as a test user, picking an account). ${HOOK_RESULTS} A failure here doesn't stop preview: the page is open, so name it in the report.

A task a hook hands you is about the page, so do it in the browser that opened \`<target>\`, and only when this session can drive that one: with this session's browser tools when the page opened there, or with the tools this session has for the workspace app's browser pane (its CLI, or a skill for it) when it opened there. Never open another browser to do it: the person sees the one that opened. When nothing here drives that browser (the system's browser, or none opened), don't do the task: put what it asks in the report for the person to do, and go on with \`--after <agent.resume>\`. A secret the task needs (a test user's password) comes from where the task says (an env file, a variable): type it into the page, never print or echo it, and never make one up.`,
          next: "main/report",
        },
        {
          id: "report",
          kind: "action",
          title: "Report",
          body: `A few lines:

- **Opened:** \`<target>\`, and where (the workspace app's browser, this session's browser tools, the system's browser, or not opened), with why it's the page: the change it shows. Any trouble \`curl\` found (a 5xx and the log lines behind it, a sign-in).
- **On the page:** each \`preview.afterOpen\` hook and what it did (signed in as whom), or what it asks the person to do when this session couldn't drive the browser, and any that failed.
- **Server:** started now (\`pid\`, \`log\`) or already running (whose: preview's, or one started by hand), and its \`url\`. When preview started it: \`{{cmd}}preview stop\` stops it. When the command came from the repo rather than the config: \`{{cmd}}configure preview\` saves it.
- **Also changed:** the other pages the change touches, as URLs, when there are any.`,
          next: null,
        },
      ],
    },
  ],
})

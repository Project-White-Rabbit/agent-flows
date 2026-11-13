---
description: Mock up a UI from a description, as a clickable page in the look of the team's design system, and show it to the person wherever this session can (a hosted page, the team's design tool, or a browser), then iterate on it from their feedback. For exploring a UI, not building production components; it writes in the working tree only when the team keeps its mockups there (`prototype.dir`), and never commits.
argument-hint: "[<description of the UI> | design [<design link>] | stop | help]"
---

# /dev-flows:prototype

Turns a description of a UI into a mockup the person can see and click through, so a direction can be judged before anyone writes production code. The mockup is the point: it's shown in the first place this session can show it, in the order `prototype.show` gives, by default: a tool that hosts a page for the person (an artifact or canvas tool the host provides), else the team's design tool (the `design` integrations the repo uses at `write`), else a browser (the workspace app's beside this session, this session's own, or the system's). The places after the one that works are its backups. It takes its look from `prototype.style`, else the team's design system (every `design` integration), else the repo's own styles. Any page behind it is scratch, kept outside the working tree, unless the team keeps its mockups in the repo (`prototype.dir`): then each is also saved there.

**Iterating.** After the report, the person's feedback in this session is more work on the same mockup, under this skill's rules: change it where it's shown (republish the same hosted page, replace the same designs, or reload the same browser page), look at it again, and say what changed. A new variant only when they ask for one, or for a pivot ("try a completely different layout"), shown beside the first rather than over it. When they ask to put it in the design tool, run the design step. When they're done, `/dev-flows:prototype stop` stops a browser mockup's server.

It never writes in the working tree outside `prototype.dir`, and never commits or pushes: a mockup that should become real work, or a saved one worth committing, is the person's call.

**CLI commands** available via Bash (paths relative to `${CLAUDE_PLUGIN_ROOT}/src/commands/`):

| Command | Description |
|---------|-------------|
| `hooks.ts <subcommand>` | `run <point>... --flow <flow>` runs the repo's hooks at those points, in order, and prints what to do next: `done`, a task for you (`agent`), a failure that stops the command (`stop`), or a hook still running (`running`) |
| `configure.ts <subcommand>` | `get <path>... [--optional]` prints configured values (`null` for an unset one with `--optional`); `integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops. Both exit 2 when the repo isn't configured for what's asked |
| `prototype.ts <subcommand>` | `dir` prints the folder for this worktree's mockup pages, and `kept`: true when it's `prototype.dir`, a folder in the repo the team keeps its mockups in, else it's a scratch folder in the worktree's git dir; `serve` serves that folder on localhost, starting the server in the background when this worktree has none, and prints its `status`, `url`, and `dir`; `stop` stops the server prototype started |

## Invariants

- **Never the working tree, unless kept.** A mockup is never written into the repo's files, except as a page in `prototype.dir` when the team keeps its mockups there, and nothing is committed or pushed. A page behind a mockup goes in a scratch folder: the one the hosting tool reads from, else the one `node "${CLAUDE_PLUGIN_ROOT}/src/commands/prototype.ts" dir` prints.
- **Self-contained.** A mockup page opens as it is: styles and scripts inline or from a CDN, no package install, no bundler, no imports from the repo's code. Read the repo's code for how its UI looks and reads; never run it to make a mockup.
- **The design tool at its level.** Read a `design` integration's design system at any level, but put a mockup in it only at `write`, and only in the `design` mode, when the person asks for it (a design link, "put this in the design file"), or when it's the first place in `<show>` this session can show a mockup. A failed write there leaves the mockup as it was.
- **Run the repo's hooks around this command.** Skip this when the mode is `help`, or when another dev-flows command is running this one (it runs its own). Once the mode is known, before the first step's work: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run before --flow prototype --mode <mode>`. When the command ends, finished or stopped, just before its report or before telling the user why it stopped: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/hooks.ts" run after --flow prototype --mode <mode> --outcome <success, when it did its job, else failure>`, leaving out a flag whose value isn't known yet. It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest (with `agent.recheck`, that first runs the hook's check again, and it fails like any check when the task didn't satisfy it); a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). `running`: a hook was still running when `--max-wait` ran out, and goes on running: run the same command again with `--wait <running.resume>` in place of any `--after`, until the status is another one, relaying `running.name` and how long it has run. When the host limits how long one command runs, add `--max-wait <a bit under that limit, in seconds>` to every `hooks.ts run`. An exit of 2 means bad arguments or an invalid config: relay its message and stop. At the end, a `stop` can't happen: report the `failures`. When `ran` lists any hook, say in the report which ran at each point, what any task for you changed, and what failed; when no point ran one, leave hooks out of the report.

## Modes

Read `$ARGUMENTS` first. If its first token is exactly one of the mode names below, run that mode. Otherwise, when this skill documents how to route the remaining arguments (see its intro), follow that; if it doesn't, run `default` and treat `$ARGUMENTS` as its input. Run only that mode's section below and skip the others.

| Mode | Trigger | What it does |
|------|---------|--------------|
| `default` | (no argument) | Mock up the UI the argument describes and show it to the person wherever this session can. |
| `design` | `design` | Put the current mockup in the team's design tool, at the design link given or the tool's own file. |
| `help` | `help` | Show usage and exit. |

## 0. Help shortcut

**Run only when mode is `help`.**

If the argument is `help`, print the block below verbatim and stop.

```
/dev-flows:prototype  [<description> | design [<design link>] | stop | help]

Mocks up a UI as a clickable page with realistic data and working controls,
in the look of the team's design system, and shows it wherever this session
can: a page the host publishes for you, else the team's design tool, else a
browser (prototype.show sets the order, and can leave one out). Feedback afterwards changes it in place. Never writes in the
working tree, unless prototype.dir names a folder the team keeps its
mockups in, and never commits.

<description>: the UI to mock up ("a settings page with billing tabs"), or
  a change to an existing screen ("the dashboard with a usage chart")
design: put the current mockup in the team's design tool (the design
  integrations configured at write), at the link given or the tool's file
stop: stops the local server a browser mockup used

The look comes from prototype.style, else the design integrations' design
system, else the repo's own styles. /dev-flows:configure design sets one up.
```

## 1. What to mock up

**`stop`:** when the argument is `stop`, run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/prototype.ts" stop`. It prints `stopped` (with the `pid` it stopped) or a `reason` none was: say which, list the mockups this session made and where each is (and, when it made several variants, the one the person preferred), and end here.

Run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" get prototype.style prototype.show --optional`: `<style>` is `prototype.style`, if set, and `<show>` is `prototype.show`, the places a mockup is shown in the order to try them, `["page", "design", "browser"]` when it's `null`. Then `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations design --optional`: the design tools the team uses, `<design>` (an empty list when it uses none). Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `script` (an adapter: the op as code, built in or the repo's own; run it, and when it exits 3 it can't run here, so go on to the next), `mcp` when this session has tools from an MCP server whose name contains `access.mcp.server` (tools that are deferred, or from a server still connecting, count: search for them with your tool search before deciding they're missing), `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Whether a way works is settled by using it, not only by how it looks: when the chosen variant fails because of the way in (the MCP server errors, disconnects, times out, or asks to sign in; the CLI says it isn't signed in or can't connect; the API answers 401, 403, 429, or 5xx, or doesn't answer), go on to the next variant the op lists, and say in the report which way failed and which one did the work. A failure from the integration itself (not found, a rejected value, a conflict, a permission the account lacks on that item) isn't one: the next way would fail the same, so handle it as the op says. Before falling back from a variant that writes (creates, updates, comments, merges), check with the op's read, or the integration's, whether the write landed anyway, so the next way doesn't do it twice. Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. An op given as `unsupported` is one that integration has nothing for: skip what needs it, and say so in the report with its reason. Run the chosen variant as given rather than a tool you know. When no variant of an op works, having tried each whose way looked available, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry with a `problem` is missing a value only this machine can supply (its ops still show that value's `{placeholder}`): don't run an op that needs it or guess the value; tell the user the problem, which says how to fix it, and treat what needs it as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them. When either exits 2 (the repo has no config yet), there's no `<style>` and no `<design>`, and `<show>` is the default: prototype works without a config.

In the `design` mode, the mockup is the one this session last made; with none, say there's nothing to put in the design tool and end here. The `<design>` entries it goes to are the ones at level `write` (the one the argument names, by its `integration` or `instance`, when it names one); with none, say which entries there are and at what level, that `/dev-flows:configure design` sets one up or raises one to `write`, and end here.

Otherwise the argument describes the UI. With none, ask the person what to mock up. When it's a change to a screen the app already has, find that screen in the repo (its route and the components it renders) so the mockup shows the change in place, with the screen's real layout, labels, and navigation around it. When it's a mockup this session already made, it's more work on that one (see Iterating), not a new one. Give it a `<name>`: a few words of the description, in kebab case (`settings-page`).

## 2. Design it

**Run only when mode is `default`.**

**The look.** The first of these that gives one:

1. `<style>`: read the files it names, or follow its words.
2. The team's design system: each `<design>` entry's `styleGuide` op, with `<link>` a design link the description gives, when it gives one. Use what they print.
3. The repo's own styles, when it has a web app: its Tailwind theme, the CSS variables in its global stylesheet, a theme or tokens module, and the components of the screen being changed.
4. A plain neutral look: zinc grays, one accent color, the Inter font.

Take its colors (as hex values), fonts, radii, spacing, and whether it's light or dark, so the mockup looks like the product. A look the description asks for wins.

**The content.** What makes a mockup worth reacting to:

- Realistic data: 10 to 20 items in a list or table, real-looking names, numbers, and dates, never lorem ipsum or "Item 1". The product's own words for things, from its code.
- Everything that looks interactive works: tabs switch, modals and drawers open and close, filters and search narrow the list, forms validate, buttons show a state.
- The states that matter: the default view, the main interaction, an empty state, and an error or loading state when the UI has one.
- Full-viewport layouts with fixed headers and sidebars and one scrolling area, sidebars at fixed widths, hover states on what can be clicked.
- One screen at a time. A UI that needs several: mock up the first, and say which would follow.

**The page.** One self-contained HTML file, whatever shows it (a design tool takes it from the page too). Tailwind from `https://cdn.tailwindcss.com` (the product's colors as a `tailwind.config` in a script), fonts from Google Fonts, icons as inline SVG, vanilla JS in one `<script>` at the end, under about 800 lines. When the hosting tool has its own rules for pages (a design skill, the script hosts it allows), follow them where they differ. Where it's written, the next step says.

## 3. Show it

**Run only when mode is `default`.**

Show the mockup in the first place `<show>` lists that this session can use, trying them in its order: `page`, `design`, and `browser` are the places below. Say in the report which one showed it, and why the ones before it in `<show>` didn't. A place `<show>` leaves out is never tried. When none it lists works here, write the page as `<name>.html` in the folder `node "${CLAUDE_PLUGIN_ROOT}/src/commands/prototype.ts" dir` prints, give the person its path to open, and say which places `<show>` lists and why each didn't work.

- **`page`: a page the host publishes.** This session has a tool that publishes an HTML page for the person to view and gives a link to it (an artifact or canvas tool; deferred tools count: search for them before deciding there's none). Load any skill it says to load first. Write the page where that tool takes files from (the scratch directory the session names, else the folder `node "${CLAUDE_PLUGIN_ROOT}/src/commands/prototype.ts" dir` prints), then publish it, private when the tool asks, titled after the mockup; `<link>` is the link it gives. A later change republishes to the same link.
- **`design`: the team's design tool.** A `<design>` entry at level `write` whose `showMockup` op works here: do as the design step says (it applies here too, whatever the mode), with `<link>` the link it prints.
- **`browser`: a browser.** Write the page as `<name>.html` in the folder `node "${CLAUDE_PLUGIN_ROOT}/src/commands/prototype.ts" dir` prints, and run `node "${CLAUDE_PLUGIN_ROOT}/src/commands/prototype.ts" serve`: it serves that folder on localhost, uncached so a reload shows the latest edit, and prints a `status` and `url`. `running` or `started`: `<link>` is `<url><name>.html`. `failed` or `timeout`: show `tail` and `log`, and give the person the page's path to open. Open `<link>` in the workspace app's browser beside this session when there is one: `node "${CLAUDE_PLUGIN_ROOT}/src/commands/configure.ts" integrations workspaces browser --optional` (exit 2: skip this), each entry used as above. Only a `browser` entry this session runs in counts (`"here": true`): find this session's workspace (the `workspaces` op of the `workspaces` entry of the same integration, the one it marks as this session's, its id `<workspace>`), then that `browser` entry's `openUrl` op with `<url>` `<link>`, `<origin>` its scheme, host, and port, and `<workspace>`. Else with this session's own browser tools, else the system's default browser (`open '<link>'` on macOS, `xdg-open '<link>'` on Linux) when there's a display.

**Keep it.** When `node "${CLAUDE_PLUGIN_ROOT}/src/commands/prototype.ts" dir` prints `kept` true (run it now when this step hasn't), the team keeps its mockups in the repo: save the page as `<name>.html` in the `dir` it prints too, wherever the mockup is shown, and save it again after each change, so the kept file is always the latest. A variant gets its own file (`<name>-2.html`). Leave it uncommitted, and say in the report where it is.

**Look at it.** When this session's browser tools can open `<link>` (a hosted page or design tool that wants a sign-in they don't have doesn't count), open it there, take a screenshot, and look: fix what's broken (a blank page, an overflowing layout, a console error) and show it again before the person sees it. Then click through its states (the main interactions, modals open, a filtered view, the empty state), a screenshot of each, kept in the session, never written into the repo. When nothing here can see it, say so.

## 4. Report

**Run only when mode is `default`.**

A few lines:

- **Mockup:** what it shows, the screen it changes (when it changes one), and where its look came from (`<style>`, the design system and which integration, the repo's styles and which file, or the neutral default).
- **See it at:** `<link>`, and the kept file's path when there is one, and where it is (a hosted page, the design tool, the workspace app's browser, this session's browser, the system's browser), with why the places before it in `<show>` weren't used.
- **States:** each one you looked at, one line on what it shows. Anything that doesn't work yet, and the screens a bigger UI would add.
- **Next:** feedback changes it in place; ask for a variant to try another direction; `/dev-flows:prototype design` puts it in the design tool (name the `<design>` entries at `write`, or, with none, say `/dev-flows:configure design` sets one up); a browser mockup's server stops with `/dev-flows:prototype stop`.

## 5. Put it in the design tool

**Run only when mode is `design`.**

For each `<design>` entry at level `write` (only the one named, when the argument names one): its `showMockup` op, with `<file>` the mockup's page (write it to the folder `node "${CLAUDE_PLUGIN_ROOT}/src/commands/prototype.ts" dir` prints when it isn't in a file yet), `<title>` the mockup's name in words, and `<link>` the design link the argument or the conversation gives, else the one that entry printed for this mockup earlier in the session, when there is one (so the same designs are replaced, not added again). When no way of the op works, say what would make it work and go on to the next entry.

Report, for each entry, the link it printed and anything that didn't carry over (an interaction, an animation).

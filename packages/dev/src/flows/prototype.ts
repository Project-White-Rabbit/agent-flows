import type { Flow } from "@agent-flows/core"
import {
  CONFIGURE_GET_AND_INTEGRATIONS,
  DEV_COMMANDS,
  devKit,
  HOOKS_COMMAND,
  hooksInvariant,
  USE_INTEGRATIONS,
} from "./kit.ts"

export const prototypeFlow: Flow = devKit.defineFlow({
  schemaVersion: 1,
  id: "prototype",
  title: "{{cmd}}prototype",
  frontmatter: {
    description:
      "Mock up a UI from a description, as a clickable page in the look of the team's design system, and show it to the person wherever this session can (a hosted page, the team's design tool, or a browser), then iterate on it from their feedback. For exploring a UI, not building production components; it never touches the working tree.",
    argumentHint:
      "[<description of the UI> | design [<design link>] | stop | help]",
  },
  commands: DEV_COMMANDS.defineCommands({
    hooks: HOOKS_COMMAND,
    configure: CONFIGURE_GET_AND_INTEGRATIONS,
    prototype: {
      description:
        "`dir` prints the scratch folder for this worktree's mockup pages (in its git dir, never the working tree); `serve` serves that folder on localhost, starting the server in the background when this worktree has none, and prints its `status`, `url`, and `dir`; `stop` stops the server prototype started",
      args: "<subcommand>",
    },
  }),
  tools: {},
  compile: { mode: { default: "monolith" }, inlinePhases: [] },
  entries: {
    default: "main/settings",
    design: "main/settings",
    help: "main/help",
  },
  defaultMode: "default",
  modeHints: {
    default:
      "Mock up the UI the argument describes and show it to the person wherever this session can.",
    design:
      "Put the current mockup in the team's design tool, at the design link given or the tool's own file.",
    help: "Show usage and exit.",
  },
  intro: `Turns a description of a UI into a mockup the person can see and click through, so a direction can be judged before anyone writes production code. The mockup is the point: it's shown wherever this session can show it, in this order: a tool that hosts a page for the person (an artifact or canvas tool the host provides), else the team's design tool (the \`design\` integrations the repo uses at \`write\`), else a browser (the workspace app's beside this session, this session's own, or the system's). It takes its look from \`prototype.style\`, else the team's design system (every \`design\` integration), else the repo's own styles. Any page behind it is scratch, kept outside the working tree.

**Iterating.** After the report, the person's feedback in this session is more work on the same mockup, under this skill's rules: change it where it's shown (republish the same hosted page, replace the same designs, or reload the same browser page), look at it again, and say what changed. A new variant only when they ask for one, or for a pivot ("try a completely different layout"), shown beside the first rather than over it. When they ask to put it in the design tool, run the design step. When they're done, \`{{cmd}}prototype stop\` stops a browser mockup's server.

It never writes in the working tree, and never commits or pushes: a mockup that should become real work is the person's call.`,
  invariants: [
    "**Never the working tree.** A mockup is never written into the repo's files, and nothing is committed or pushed. A page behind a mockup goes in a scratch folder: the one the hosting tool reads from, else the one `{{command:prototype}} dir` prints (in the worktree's git dir).",
    "**Self-contained.** A mockup page opens as it is: styles and scripts inline or from a CDN, no package install, no bundler, no imports from the repo's code. Read the repo's code for how its UI looks and reads; never run it to make a mockup.",
    "**The design tool at its level.** Read a `design` integration's design system at any level, but put a mockup in it only at `write`, and only in the `design` mode, when the person asks for it (a design link, \"put this in the design file\"), or when it's the first place this session can show a mockup. A failed write there leaves the mockup as it was.",
    hooksInvariant("prototype"),
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
{{cmd}}prototype  [<description> | design [<design link>] | stop | help]

Mocks up a UI as a clickable page with realistic data and working controls,
in the look of the team's design system, and shows it wherever this session
can: a page the host publishes for you, else the team's design tool, else a
browser. Feedback afterwards changes it in place. Never writes in the
working tree.

<description>: the UI to mock up ("a settings page with billing tabs"), or
  a change to an existing screen ("the dashboard with a usage chart")
design: put the current mockup in the team's design tool (the design
  integrations configured at write), at the link given or the tool's file
stop: stops the local server a browser mockup used

The look comes from prototype.style, else the design integrations' design
system, else the repo's own styles. /dev-flows:configure design sets one up.
\`\`\``,
          next: "main/settings",
        },
        {
          id: "settings",
          kind: "action",
          title: "What to mock up",
          commandCalls: ["configure", "prototype"],
          body: `**\`stop\`:** when the argument is \`stop\`, run \`{{command:prototype}} stop\`. It prints \`stopped\` (with the \`pid\` it stopped) or a \`reason\` none was: say which, list the mockups this session made and where each is (and, when it made several variants, the one the person preferred), and end here.

Run \`{{command:configure}} get prototype.style --optional\`: \`<style>\` is \`prototype.style\`, if set. Then \`{{command:configure}} integrations design --optional\`: the design tools the team uses, \`<design>\` (an empty list when it uses none). ${USE_INTEGRATIONS} When either exits 2 (the repo has no config yet), there's no \`<style>\` and no \`<design>\`: prototype works without a config.

In the \`design\` mode, the mockup is the one this session last made; with none, say there's nothing to put in the design tool and end here. The \`<design>\` entries it goes to are the ones at level \`write\` (the one the argument names, by its \`integration\` or \`instance\`, when it names one); with none, say which entries there are and at what level, that \`{{cmd}}configure design\` sets one up or raises one to \`write\`, and end here.

Otherwise the argument describes the UI. With none, ask the person what to mock up. When it's a change to a screen the app already has, find that screen in the repo (its route and the components it renders) so the mockup shows the change in place, with the screen's real layout, labels, and navigation around it. When it's a mockup this session already made, it's more work on that one (see Iterating), not a new one. Give it a \`<name>\`: a few words of the description, in kebab case (\`settings-page\`).`,
          next: {
            byMode: {
              default: "main/design",
              design: "main/design-tool",
              help: null,
            },
          },
        },
        {
          id: "design",
          kind: "action",
          title: "Design it",
          body: `**The look.** The first of these that gives one:

1. \`<style>\`: read the files it names, or follow its words.
2. The team's design system: each \`<design>\` entry's \`styleGuide\` op, with \`<link>\` a design link the description gives, when it gives one. Use what they print.
3. The repo's own styles, when it has a web app: its Tailwind theme, the CSS variables in its global stylesheet, a theme or tokens module, and the components of the screen being changed.
4. A plain neutral look: zinc grays, one accent color, the Inter font.

Take its colors (as hex values), fonts, radii, spacing, and whether it's light or dark, so the mockup looks like the product. A look the description asks for wins.

**The content.** What makes a mockup worth reacting to:

- Realistic data: 10 to 20 items in a list or table, real-looking names, numbers, and dates, never lorem ipsum or "Item 1". The product's own words for things, from its code.
- Everything that looks interactive works: tabs switch, modals and drawers open and close, filters and search narrow the list, forms validate, buttons show a state.
- The states that matter: the default view, the main interaction, an empty state, and an error or loading state when the UI has one.
- Full-viewport layouts with fixed headers and sidebars and one scrolling area, sidebars at fixed widths, hover states on what can be clicked.
- One screen at a time. A UI that needs several: mock up the first, and say which would follow.

**The page.** One self-contained HTML file, whatever shows it (a design tool takes it from the page too). Tailwind from \`https://cdn.tailwindcss.com\` (the product's colors as a \`tailwind.config\` in a script), fonts from Google Fonts, icons as inline SVG, vanilla JS in one \`<script>\` at the end, under about 800 lines. When the hosting tool has its own rules for pages (a design skill, the script hosts it allows), follow them where they differ. Where it's written, the next step says.`,
          next: "main/show",
        },
        {
          id: "show",
          kind: "action",
          title: "Show it",
          commandCalls: ["configure", "prototype"],
          body: `Show the mockup in the first of these this session can use, saying in the report which, and why the ones before it weren't:

1. **A page the host publishes.** This session has a tool that publishes an HTML page for the person to view and gives a link to it (an artifact or canvas tool; deferred tools count: search for them before deciding there's none). Load any skill it says to load first. Write the page where that tool takes files from (the scratch directory the session names, else the folder \`{{command:prototype}} dir\` prints), then publish it, private when the tool asks, titled after the mockup; \`<link>\` is the link it gives. A later change republishes to the same link.
2. **The team's design tool.** A \`<design>\` entry at level \`write\` whose \`showMockup\` op works here: do as the design step says (it applies here too, whatever the mode), with \`<link>\` the link it prints.
3. **A browser.** Write the page as \`<name>.html\` in the folder \`{{command:prototype}} dir\` prints, and run \`{{command:prototype}} serve\`: it serves that folder on localhost, uncached so a reload shows the latest edit, and prints a \`status\` and \`url\`. \`running\` or \`started\`: \`<link>\` is \`<url><name>.html\`. \`failed\` or \`timeout\`: show \`tail\` and \`log\`, and give the person the page's path to open. Open \`<link>\` in the workspace app's browser beside this session when there is one: \`{{command:configure}} integrations workspaces browser --optional\` (exit 2: skip this), each entry used as above. Only a \`browser\` entry this session runs in counts (\`"here": true\`): find this session's workspace (the \`workspaces\` op of the \`workspaces\` entry of the same integration, the one it marks as this session's, its id \`<workspace>\`), then that \`browser\` entry's \`openUrl\` op with \`<url>\` \`<link>\`, \`<origin>\` its scheme, host, and port, and \`<workspace>\`. Else with this session's own browser tools, else the system's default browser (\`open '<link>'\` on macOS, \`xdg-open '<link>'\` on Linux) when there's a display.

**Look at it.** When this session's browser tools can open \`<link>\` (a hosted page or design tool that wants a sign-in they don't have doesn't count), open it there, take a screenshot, and look: fix what's broken (a blank page, an overflowing layout, a console error) and show it again before the person sees it. Then click through its states (the main interactions, modals open, a filtered view, the empty state), a screenshot of each, kept in the session, never written into the repo. When nothing here can see it, say so.`,
          next: "main/report",
        },
        {
          id: "report",
          kind: "action",
          title: "Report",
          body: `A few lines:

- **Mockup:** what it shows, the screen it changes (when it changes one), and where its look came from (\`<style>\`, the design system and which integration, the repo's styles and which file, or the neutral default).
- **See it at:** \`<link>\`, and where it is (a hosted page, the design tool, the workspace app's browser, this session's browser, the system's browser), with why the places before it weren't used.
- **States:** each one you looked at, one line on what it shows. Anything that doesn't work yet, and the screens a bigger UI would add.
- **Next:** feedback changes it in place; ask for a variant to try another direction; \`{{cmd}}prototype design\` puts it in the design tool (name the \`<design>\` entries at \`write\`, or, with none, say \`{{cmd}}configure design\` sets one up); a browser mockup's server stops with \`{{cmd}}prototype stop\`.`,
          next: null,
        },
        {
          id: "design-tool",
          kind: "action",
          title: "Put it in the design tool",
          body: `For each \`<design>\` entry at level \`write\` (only the one named, when the argument names one): its \`showMockup\` op, with \`<file>\` the mockup's page (write it to the folder \`{{command:prototype}} dir\` prints when it isn't in a file yet), \`<title>\` the mockup's name in words, and \`<link>\` the design link the argument or the conversation gives, else the one that entry printed for this mockup earlier in the session, when there is one (so the same designs are replaced, not added again). When no way of the op works, say what would make it work and go on to the next entry.

Report, for each entry, the link it printed and anything that didn't carry over (an interaction, an animation).`,
          next: null,
        },
      ],
    },
  ],
})

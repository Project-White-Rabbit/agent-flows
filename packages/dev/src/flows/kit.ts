import {
  claudeCode,
  createFlowKit,
  defineCommandCatalog,
} from "@agent-flows/core"

export const PLUGIN = "dev-flows"

export const devKit = createFlowKit({
  targets: {
    claude: claudeCode({ plugin: PLUGIN }),
  },
  commands: {
    // Commands are TypeScript run directly by node (type stripping), so the
    // plugin ships its sources with no build step and no dependencies.
    invoke: (c) => `node "{{pluginRoot}}/src/commands/${c.file}"`,
    tableIntro:
      "**CLI commands** available via Bash (paths relative to `{{pluginRoot}}/src/commands/`):",
  },
})

export const DEV_COMMANDS = defineCommandCatalog({
  configure: { file: "configure.ts" },
  hooks: { file: "hooks.ts" },
  ready: { file: "ready.ts" },
  sync: { file: "sync.ts" },
  tickets: { file: "tickets.ts" },
  work: { file: "work.ts" },
})

export type DevTargetName = (typeof devKit.targetNames)[number]

const INTEGRATIONS_USAGE =
  "`integrations <capability>... [--optional]` prints the entries configured for a capability, with their values and ops"

/** The `configure` command entry for a flow that reads only integrations. */
export const CONFIGURE_INTEGRATIONS = {
  description: `${INTEGRATIONS_USAGE}. Exits 2 when the repo isn't configured for it`,
  args: "<subcommand>",
}

/** The `configure` command entry for a flow that also reads config values. */
export const CONFIGURE_GET_AND_INTEGRATIONS = {
  description: `\`get <path>... [--optional]\` prints configured values (\`null\` for an unset one with \`--optional\`); ${INTEGRATIONS_USAGE}. Both exit 2 when the repo isn't configured for what's asked`,
  args: "<subcommand>",
}

/**
 * Where a flow keeps its files: the worktree's private git dir, so they never
 * land in the tree and each worktree has its own.
 */
export function flowDir(flow: string): string {
  return `\`git rev-parse --absolute-git-dir\` plus \`/agent-flows/${flow}\``
}

/**
 * Prose for a step that reads configuration with `configure.ts get` or
 * `configure.ts integrations`: what to do when the repo isn't configured for
 * it. Every config-reading step uses this, so every flow fails the same way.
 */
export const REQUIRE_CONFIG =
  "If it exits with status 2 and prints `\"configured\": false`, stop this command here. Relay its `message`: the repo isn't set up for dev-flows yet, its config is invalid (`issues`), or it doesn't set what this command needs (`missing`: config paths, or capabilities with no integration). Tell the user to run `{{cmd}}configure` (naming the missing sections or capabilities, if any) and then re-run this command. Don't guess the values instead."

/**
 * Prose for a step that takes flags out of the arguments: what to do with one
 * the command doesn't take. Flags are read, not parsed, so without this a
 * mistyped flag is silently dropped. Only the entry skill's flag step uses it:
 * phases get the arguments already checked.
 */
export const UNKNOWN_FLAGS =
  "Any other argument that starts with `--` is a flag this command doesn't take: name it, print the usage block from `help`, and stop, rather than running without it. A `--` inside pasted notes, a quoted value, or a command the notes quote (`git push --force`) is part of that text, not a flag."

/**
 * Prose for using what `configure.ts integrations` returns. Flows name
 * capabilities and ops, never a vendor or its CLI, so a repo's choice of
 * integrations (and how many) changes nothing in the skill.
 */
export const USE_INTEGRATIONS =
  "Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `script` (an adapter: the op as code, built in or the repo's own; run it, and when it exits 3 it can't run here, so go on to the next), `mcp` when this session has tools from an MCP server whose name contains `access.mcp.server` (tools that are deferred, or from a server still connecting, count: search for them with your tool search before deciding they're missing), `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. An op given as `unsupported` is one that integration has nothing for: skip what needs it, and say so in the report with its reason. Run the chosen variant as given rather than a tool you know. When no variant of an op works, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them."

/**
 * Prose for finding a branch's parent: what it diffs against, opens its pull
 * request into, and catches up to. Every flow that reads a parent uses this,
 * so a parent that already merged is caught the same way everywhere. Needs
 * `<base>` and the stacking and source-control entries.
 */
export const STACK_PARENT =
  "With a stacking entry, its `parent` op. When that succeeds and names a branch other than `<base>`, check it hasn't already merged: the source-control entry's `branchPr` op for it (with no source-control entry, skip the check). Merged means it landed, so `<parent>` is the base that pull request merged into, and `<landed>` is the old parent: `{{cmd}}sync` moves the branch off it (until then, the branch still holds the landed parent's commits, so compare its own work against `<landed>`, not `<parent>`). Otherwise `<parent>` is the branch the op named. When there's no stacking entry, or its `parent` op fails (the branch isn't tracked): the pull request's base branch when there's a pull request, else `<base>`."

/** The `hooks` command entry: every flow but configure runs the general points. */
export const HOOKS_COMMAND = {
  description:
    "`run <point>... --flow <flow>` runs the repo's hooks at those points, in order, and prints what to do next: `done`, a task for you (`agent`), or a failure that stops the command (`stop`)",
  args: "<subcommand>",
}

/**
 * Prose for acting on what `hooks.ts run` prints. Every point uses it, so a
 * hook's task gets the same rules wherever it runs.
 */
export const HOOK_RESULTS =
  "It prints JSON with a `status`. `done`: carry on; `failures`, if any, are hooks that failed at a point that reports them rather than stops, so name them in the report. `agent`: a hook handed you `agent.task` (a prompt from the config, or what a check printed when it exited 2). Do it now, under this command's own rules (the same bar as any fix, and nothing they forbid), then run the same command again with `--after <agent.resume>` for the rest; a task you can't do with confidence is a stop: say so, and ask. `stop`: a hook failed (after its fix, when it has one): stop this command and show the user `stop.name` and `stop.output` (the full log is at `stop.log`). An exit of 2 means bad arguments or an invalid config: relay its message and stop."

/**
 * The flow-wide rule for the general hooks, and the flow's own `after` point
 * when it has one. `extra` is the flags the flow passes besides its mode
 * (`--base <mergeBase>`).
 */
export function hooksInvariant(
  flow: string,
  options: { afterPoint?: boolean; extra?: string } = {},
): string {
  const extra = options.extra ? ` ${options.extra}` : ""
  const points = options.afterPoint ? `${flow}.after after` : "after"
  return `**Run the repo's hooks around this command.** Skip this when the mode is \`help\`, or when another dev-flows command is running this one (it runs its own). Once the mode is known, before the first step's work: \`{{command:hooks}} run before --flow ${flow} --mode <mode>\`. When the command ends, finished or stopped, just before its report or before telling the user why it stopped: \`{{command:hooks}} run ${points} --flow ${flow} --mode <mode>${extra} --outcome <success, when it did its job, else failure>\`, leaving out a flag whose value isn't known yet. ${HOOK_RESULTS} At the end, a \`stop\` can't happen: report the \`failures\`. Say in the report which hooks ran at each point, what any task for you changed, and what failed.`
}

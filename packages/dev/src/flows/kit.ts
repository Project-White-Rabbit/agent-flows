import {
  claudeCode,
  createFlowKit,
  defineCommandCatalog,
} from "@agent-flows/core"

export const PLUGIN = "agent-flows"

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
  sync: { file: "sync.ts" },
})

export type DevTargetName = (typeof devKit.targetNames)[number]

/**
 * Prose for a step that reads configuration with `configure.ts get` or
 * `configure.ts integrations`: what to do when the repo isn't configured for
 * it. Every config-reading step uses this, so every flow fails the same way.
 */
export const REQUIRE_CONFIG =
  "If it exits with status 2 and prints `\"configured\": false`, stop this command here. Relay its `message`: the repo isn't set up for agent-flows yet, its config is invalid (`issues`), or it doesn't set what this command needs (`missing`: config paths, or capabilities with no integration). Tell the user to run `{{cmd}}configure` (naming the missing sections or capabilities, if any) and then re-run this command. Don't guess the values instead."

/**
 * Prose for using what `configure.ts integrations` returns. Flows name
 * capabilities and ops, never a vendor or its CLI, so a repo's choice of
 * integrations (and how many) changes nothing in the skill.
 */
export const USE_INTEGRATIONS =
  "Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values`, its `access` (how this machine can reach it), and its `ops`. An op says how that integration does the job, with config values already filled in and `<N>`-style placeholders for you to fill: one string when it's the same however you reach the integration, else one variant per way to reach it. For each op, use the first variant, in the order the op lists them, whose way works here: `mcp` when you have tools from the MCP server `access.mcp.server` names, `cli` when `access.cli.ready` (installed and signed in), `api` when `access.api.ready` (the variant reads the token from the variable `access.api.token` names; never print or echo a token). Most ops list MCP, then CLI, then API; one that lists them otherwise does so because that way is more exact. Run the chosen variant as given rather than a tool you know. When no variant of an op works, don't improvise one: tell the user what would make it work (connect the MCP server, install the CLI or sign in with `access.cli.auth`, or set the token variable) and treat that action as unavailable. An entry's `level`, for a capability that has levels, is how far the team lets flows go with that integration (set by configure, from the capability's levels); never do more with it than its level allows. A capability can have several integrations, and the skill works the same with any of them."

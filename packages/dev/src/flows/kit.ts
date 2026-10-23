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
  "Each entry is one configured integration, or one instance of an integration configured more than once (two repositories on one host, told apart by `instance`): its `values` and its `ops`, where each op says how that integration does the job (a command, or prose), with config values already filled in and `<N>`-style placeholders for you to fill. Use the ops as given rather than a CLI you know; a capability can have several integrations, and the skill works the same with any of them."

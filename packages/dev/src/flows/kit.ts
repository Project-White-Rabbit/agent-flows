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
 * Prose for a step that reads configuration with `configure.ts get`: what to
 * do when the repo isn't configured for it. Every config-reading step uses
 * this, so every flow fails the same way.
 */
export const REQUIRE_CONFIG =
  "If it exits with status 2 and prints `\"configured\": false`, stop this command here. Relay its `message`: the repo isn't set up for agent-flows yet, its config is invalid (`issues`), or it doesn't set what this command needs (`missing`). Tell the user to run `{{cmd}}configure` (naming the missing sections, if any) and then re-run this command. Don't guess the values instead."

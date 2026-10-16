import { createFlowKit } from "../kit.js"
import type { Flow as FlowType } from "../schema.js"
import { amp, claudeCode, codex, cursor } from "../targets.js"

/**
 * A four-host kit shaped like a real plugin ("acme" with an `Acme` MCP
 * server and node CLI commands), shared by the test suites.
 */
const sections = {
  "ask-user-question": ["claude", "cursor"],
  "plugin-dir-lookup": ["codex", "amp"],
} as const

const commands = {
  invoke: (c: { file: string }) =>
    `node "{{pluginRoot}}/dist/commands/${c.file}"`,
  tableIntro:
    "**CLI commands** available via Bash (all paths relative to `{{pluginRoot}}/dist/commands/`):",
}

const pluginDir = { markerFile: "dist/commands/status.js" }

export const kit = createFlowKit({
  targets: {
    claude: claudeCode({
      plugin: "acme",
      mcpServer: "Acme",
      tokens: { devCmd: "/acme-dev:" },
    }),
    cursor: cursor({
      plugin: "acme",
      mcpServer: "Acme",
      tokens: { devCmd: "/acme-dev-" },
    }),
    codex: codex({
      plugin: "acme",
      mcpServer: "Acme",
      pluginDir,
      tokens: { devCmd: "$acme-dev:" },
    }),
    amp: amp({ plugin: "acme", pluginDir, tokens: { devCmd: "acme-dev:" } }),
  },
  sections,
  commands,
})

/** Same hosts under a second plugin namespace with usage in the body. */
export const devKit = createFlowKit({
  targets: {
    claude: claudeCode({
      plugin: "acme",
      mcpServer: "Acme",
      tokens: { devCmd: "/acme-dev:" },
    }),
    cursor: cursor({
      plugin: "acme-dev",
      mcpServer: "Acme",
      usageInBody: true,
      tokens: { cmd: "/acme-", devCmd: "/acme-dev-" },
    }),
    codex: codex({
      plugin: "acme-dev",
      mcpServer: "Acme",
      usageInBody: true,
      pluginDir: { ...pluginDir, envVar: "ACME_PLUGIN_DIR" },
      tokens: { cmd: "$acme:", devCmd: "$acme-dev:" },
    }),
    amp: amp({
      plugin: "acme-dev",
      usageInBody: true,
      pluginDir: { ...pluginDir, envVar: "ACME_PLUGIN_DIR" },
      tokens: { cmd: "acme:", devCmd: "acme-dev:" },
    }),
  },
  sections,
  commands,
})

export const TARGETS = kit.targets
export const DEV_TARGETS = devKit.targets
export const Flow = kit.schema
export type Flow = FlowType

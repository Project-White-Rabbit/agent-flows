/** Inputs a target's frontmatter renderer receives for one generated file. */
export interface FrontmatterInput {
  /** Skill id: the flow id, or `<flow>-<phase>` for a phase sub-skill. */
  flowId: string
  description: string
  argumentHint?: string
  model?: string
  allowedTools?: string[]
}

/**
 * How one agent host consumes generated skills. Everything host-specific the
 * renderer needs lives here; flows stay host-agnostic and branch on target
 * names only through per-target values and `{{#target}}` sections.
 */
export interface TargetSpec {
  /**
   * `{{name}}` tokens substituted into every rendered file (invocation prefix,
   * editor name, plugin root, …). Flow variables may not shadow these names.
   */
  tokens: Record<string, string>
  /** Prefix prepended to `kind: "mcp"` tool names in prose and `allowed-tools`. */
  mcpPrefix: string
  /** How skill prose names the user's arguments (`$ARGUMENTS`, "the user's request"). */
  argsToken: string
  /** Frontmatter for a user-invocable skill (monolith or split orchestrator). */
  frontmatter: (input: FrontmatterInput) => string
  /** Frontmatter for a model-invoked phase sub-skill. */
  subSkillFrontmatter: (input: FrontmatterInput) => string
  /**
   * Tool the host uses to invoke another skill (Claude Code: `Skill`). Added
   * to a split file's derived `allowed-tools` when it dispatches onward.
   */
  subSkillTool?: string
  /** How prose names a sibling skill; defaults to `` `name` ``. */
  dispatchRef?: (skillName: string) => string
  /**
   * Under `split-chain`, emit non-inline phases as plain reference files
   * (`references/<phase>.md`) that the orchestrator links to, instead of
   * separately discoverable sub-skills. Keeps phase names out of hosts whose
   * skill discovery would otherwise list every phase.
   */
  phaseReferences?: boolean
}

/** A target bound to its name. */
export interface Target extends TargetSpec {
  name: string
}

export function formatAllowedTools(allowedTools: string[]): string {
  return `[${allowedTools.map((t) => JSON.stringify(t)).join(", ")}]`
}

/**
 * Claude Code style frontmatter: `description`, optional `argument-hint`,
 * `model`, `allowed-tools`. The skill name comes from its directory.
 */
export function claudeFrontmatter({
  description,
  argumentHint,
  model,
  allowedTools,
}: FrontmatterInput): string {
  const lines = ["---", `description: ${description}`]
  if (argumentHint !== undefined) {
    lines.push(`argument-hint: ${JSON.stringify(argumentHint)}`)
  }
  if (model !== undefined) {
    lines.push(`model: ${model}`)
  }
  if (allowedTools !== undefined) {
    lines.push(`allowed-tools: ${formatAllowedTools(allowedTools)}`)
  }
  lines.push("---")
  return lines.join("\n")
}

/** Claude Code frontmatter for a hidden, model-invocable sub-skill. */
export function claudeSubSkillFrontmatter({
  flowId,
  description,
  model,
  allowedTools,
}: FrontmatterInput): string {
  const lines = [
    "---",
    `name: ${flowId}`,
    `description: ${description}`,
    "user-invocable: false",
  ]
  if (model !== undefined) {
    lines.push(`model: ${model}`)
  }
  if (allowedTools !== undefined) {
    lines.push(`allowed-tools: ${formatAllowedTools(allowedTools)}`)
  }
  lines.push("---")
  return lines.join("\n")
}

/**
 * `name` + quoted `description` frontmatter (Cursor, Codex, Amp). Hosts with
 * no `argument-hint` field get the usage clause appended to the description,
 * or (with `usageInBody`) as the first body line instead.
 */
export function namedFrontmatter(
  name: string,
  description: string,
  usage: string,
  usageInBody = false,
): string {
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: "${description}${usageInBody ? "" : usage}"`,
    "---",
  ].join("\n")
  return usageInBody && usage !== ""
    ? `${frontmatter}\n\n${usage.slice(2)}`
    : frontmatter
}

const ASK_USER_QUESTION_TOKENS = {
  askUser: "with `AskUserQuestion` ",
  askVerb: "use `AskUserQuestion`",
  askVerbCap: "Use `AskUserQuestion`",
  askNoun: "AskUserQuestion",
}

const PLAIN_PROMPT_TOKENS = {
  askUser: "",
  askVerb: "ask the user",
  askVerbCap: "Ask the user",
  askNoun: "choice prompt",
}

interface PresetOptions {
  /** Plugin namespace, e.g. `acme` → `/acme:setup`. */
  plugin: string
  /** MCP server name the plugin ships, used to build `mcpPrefix`. */
  mcpServer?: string
  /** Explicit MCP tool prefix, overriding the one derived from `mcpServer`. */
  mcpPrefix?: string
  /** Extra or overriding `{{tokens}}`. */
  tokens?: Record<string, string>
  /**
   * Put the usage clause in the body instead of the frontmatter description
   * (namespaced hosts only). Useful when descriptions have a length budget.
   */
  usageInBody?: boolean
}

/**
 * Claude Code plugin skills. Tokens: `cmd` (`/plugin:`), `editor`,
 * `pluginRoot` (`${CLAUDE_PLUGIN_ROOT}`), `pluginDirLookup` (empty), and the
 * `ask*` tokens naming `AskUserQuestion`.
 */
export function claudeCode(options: PresetOptions): TargetSpec {
  return {
    tokens: {
      cmd: `/${options.plugin}:`,
      editor: "Claude Code",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable rendered into skill markdown
      pluginRoot: "${CLAUDE_PLUGIN_ROOT}",
      pluginDirLookup: "",
      ...ASK_USER_QUESTION_TOKENS,
      ...options.tokens,
    },
    mcpPrefix:
      options.mcpPrefix ??
      (options.mcpServer !== undefined
        ? `mcp__plugin_${options.plugin}_${options.mcpServer}__`
        : ""),
    argsToken: "$ARGUMENTS",
    frontmatter: claudeFrontmatter,
    subSkillFrontmatter: claudeSubSkillFrontmatter,
    subSkillTool: "Skill",
  }
}

/** Cursor plugin skills, named `<plugin>-<flow>` and invoked as `/<plugin>-<flow>`. */
export function cursor(options: PresetOptions): TargetSpec {
  const render = ({ flowId, description, argumentHint }: FrontmatterInput) => {
    const name = `${options.plugin}-${flowId}`
    const usage =
      argumentHint !== undefined ? `. Usage: /${name} ${argumentHint}` : ""
    return namedFrontmatter(name, description, usage, options.usageInBody)
  }
  return {
    tokens: {
      cmd: `/${options.plugin}-`,
      editor: "Cursor",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable rendered into skill markdown
      pluginRoot: "${CURSOR_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}",
      pluginDirLookup: "",
      ...ASK_USER_QUESTION_TOKENS,
      ...options.tokens,
    },
    mcpPrefix:
      options.mcpPrefix ??
      (options.mcpServer !== undefined ? `mcp__${options.mcpServer}__` : ""),
    argsToken: "$ARGUMENTS",
    frontmatter: render,
    subSkillFrontmatter: render,
  }
}

interface PluginDirOptions {
  /** Env var the resolved plugin dir is exported as (default `<PLUGIN>_PLUGIN_DIR`). */
  envVar?: string
  /**
   * File (relative to the plugin root) whose presence identifies an install,
   * e.g. `dist/commands/status.js`.
   */
  markerFile: string
}

function defaultEnvVar(plugin: string): string {
  return `${plugin.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PLUGIN_DIR`
}

/**
 * Bash that resolves a Codex plugin's install dir from the plugin cache into
 * `envVar`, failing loudly when the plugin isn't installed. Codex exposes no
 * plugin-root variable, so skills that run plugin files need this first.
 */
export function codexPluginDirLookup(
  plugin: string,
  { envVar = defaultEnvVar(plugin), markerFile }: PluginDirOptions,
): string {
  return `\`\`\`bash
if [ -z "$${envVar}" ]; then
  ${envVar}=$(
    hit=$(find "\${CODEX_HOME:-$HOME/.codex}/plugins/cache" -maxdepth 8 -type f \\
      -path '*/${plugin}/*/${markerFile}' 2>/dev/null | head -1)
    echo "\${hit%/${markerFile}}"
  )
  export ${envVar}
fi
test -n "$${envVar}" || { echo "ERROR: ${plugin} plugin not installed"; exit 1; }
\`\`\``
}

/** Bash that resolves an Amp plugin's dir (project, then user config) into `envVar`. */
export function ampPluginDirLookup(
  plugin: string,
  { envVar = defaultEnvVar(plugin), markerFile }: PluginDirOptions,
): string {
  return `\`\`\`bash
if [ -z "$${envVar}" ]; then
  project_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  for candidate in "$project_root/.amp/plugins/${plugin}" "\${XDG_CONFIG_HOME:-$HOME/.config}/amp/plugins/${plugin}"; do
    if [ -f "$candidate/${markerFile}" ]; then
      ${envVar}="$candidate"
      break
    fi
  done
  export ${envVar}
fi
test -n "$${envVar}" || { echo "ERROR: ${plugin} plugin not installed"; exit 1; }
\`\`\``
}

interface NamespacedPresetOptions extends PresetOptions {
  /**
   * How skills locate the plugin's files. When set, `{{pluginRoot}}` renders
   * as `${envVar}` and `{{pluginDirLookup}}` as the resolving bash block.
   * Omit when skills never reference plugin files.
   */
  pluginDir?: PluginDirOptions
}

function pluginDirTokens(
  plugin: string,
  pluginDir: PluginDirOptions | undefined,
  lookup: typeof codexPluginDirLookup,
): Record<string, string> {
  if (pluginDir === undefined) {
    return {}
  }
  return {
    pluginRoot: `\${${pluginDir.envVar ?? defaultEnvVar(plugin)}}`,
    pluginDirLookup: lookup(plugin, pluginDir),
  }
}

/**
 * Codex plugin skills, invoked as `$plugin:flow`. Split-chain phases compile
 * to reference files by default so they stay out of skill discovery.
 */
export function codex(
  options: NamespacedPresetOptions & { phaseReferences?: boolean },
): TargetSpec {
  const render = ({ flowId, description, argumentHint }: FrontmatterInput) => {
    const usage =
      argumentHint !== undefined
        ? `. Invoke with $${options.plugin}:${flowId} ${argumentHint}.`
        : ""
    return namedFrontmatter(flowId, description, usage, options.usageInBody)
  }
  return {
    tokens: {
      cmd: `$${options.plugin}:`,
      editor: "Codex",
      ...pluginDirTokens(
        options.plugin,
        options.pluginDir,
        codexPluginDirLookup,
      ),
      ...PLAIN_PROMPT_TOKENS,
      ...options.tokens,
    },
    mcpPrefix:
      options.mcpPrefix ??
      (options.mcpServer !== undefined ? `mcp__${options.mcpServer}__` : ""),
    argsToken: "$ARGUMENTS",
    frontmatter: render,
    subSkillFrontmatter: render,
    dispatchRef: (skillName) => `\`$${options.plugin}:${skillName}\``,
    phaseReferences: options.phaseReferences ?? true,
  }
}

/** Amp plugin skills, invoked as `plugin:flow`. */
export function amp(options: NamespacedPresetOptions): TargetSpec {
  const render = ({ flowId, description, argumentHint }: FrontmatterInput) => {
    const usage =
      argumentHint !== undefined
        ? `. Invoke as ${options.plugin}:${flowId} ${argumentHint}.`
        : ""
    return namedFrontmatter(flowId, description, usage, options.usageInBody)
  }
  return {
    tokens: {
      cmd: `${options.plugin}:`,
      editor: "Amp",
      ...pluginDirTokens(options.plugin, options.pluginDir, ampPluginDirLookup),
      ...PLAIN_PROMPT_TOKENS,
      ...options.tokens,
    },
    // Amp exposes MCP tools under their bare names.
    mcpPrefix: options.mcpPrefix ?? "",
    argsToken: "the user's request",
    frontmatter: render,
    subSkillFrontmatter: render,
    subSkillTool: "skill",
    dispatchRef: (skillName) => `\`${options.plugin}:${skillName}\``,
  }
}

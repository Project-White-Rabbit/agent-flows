import { z } from "zod"
import { type DiagramOptions, describeFlow, renderMermaid } from "./mermaid.js"
import {
  type CommandDef,
  type RenderedFile,
  type RenderTarget,
  renderFlow,
  renderMarkdown,
} from "./render.js"
import {
  createFlowSchema,
  type Flow,
  type FlowInput,
  type FlowSchemaOptions,
} from "./schema.js"
import type { Target, TargetSpec } from "./targets.js"

/** How `{{command:id}}` placeholders and the command table render. */
export interface CommandConventions {
  /**
   * Render one invocation. Default: the command's `file` verbatim. A plugin
   * shipping node scripts might use
   * `(c) => \`node "{{pluginRoot}}/dist/commands/${c.file}"\``.
   */
  invoke?: (command: CommandDef, target: Target) => string
  /** Markdown preceding the command reference table. */
  tableIntro?: string | ((target: Target) => string)
  /**
   * Builtin tool the agent runs commands with (default `Bash`). A phase that
   * uses a command gets this tool in its derived `allowed-tools` when the
   * flow registers it.
   */
  runnerTool?: string
}

export interface FlowKitConfig<Names extends string> {
  /** Hosts to render for, keyed by target name (lowercase, kebab-case). */
  targets: { [K in Names]: TargetSpec }
  /**
   * Named target groups for `{{#group}}…{{/group}}` sections, e.g.
   * `{ "ask-user-question": ["claude", "cursor"] }`. Each target name is
   * implicitly a section containing just itself.
   */
  sections?: Record<string, readonly NoInfer<Names>[]>
  commands?: CommandConventions
}

/** One rendered file mapped to its output path. */
export interface GeneratedFile {
  flowId: string
  target: string
  kind: RenderedFile["kind"]
  path: string
  content: string
}

/**
 * Where a flow's files land for one target. A string is the main skill file;
 * split phases then default to sibling skill dirs named `<dir>-<phase>` and
 * phase references to `references/<phase>.md` next to the main file. The
 * object form sets the phase sub-skill pattern explicitly (`{phase}` is
 * replaced by the phase id).
 */
export type OutputPath = string | { main: string; phase: string }

export interface FlowOutputs<Names extends string> {
  flow: Flow
  outputs: Partial<Record<Names, OutputPath>>
}

export interface FlowKit<Names extends string> {
  readonly targetNames: readonly Names[]
  readonly targets: { readonly [K in Names]: RenderTarget }
  /** Validating zod schema for flows in this kit. */
  readonly schema: ReturnType<typeof createFlowSchema>
  /** Parse and validate a flow, throwing a readable error on failure. */
  defineFlow(input: FlowInput): Flow
  /** Render a flow for one target (one file, or several when split). */
  render(flow: Flow, target: Names): RenderedFile[]
  /** Render a flow for one target as a single monolith file, ignoring `compile.mode`. */
  renderMarkdown(flow: Flow, target: Names): string
  /** Render every flow for every configured output into path-addressed files. */
  renderProject(projects: readonly FlowOutputs<Names>[]): GeneratedFile[]
  renderMermaid(flow: Flow, options?: DiagramOptions | string): string
  describeFlow(flow: Flow, target?: Names): string
}

const NAME_RE = /^[a-z][a-z0-9-]*$/

export function createFlowKit<const Names extends string>(
  config: FlowKitConfig<Names>,
): FlowKit<Names> {
  const targetNames = Object.keys(config.targets) as Names[]
  if (targetNames.length === 0) {
    throw new Error("createFlowKit: at least one target is required")
  }
  for (const name of targetNames) {
    if (!NAME_RE.test(name) || name === "default") {
      throw new Error(
        `createFlowKit: invalid target name "${name}" (use lowercase kebab-case; "default" is reserved)`,
      )
    }
  }

  const groups: Record<string, readonly string[]> = {}
  for (const name of targetNames) {
    groups[name] = [name]
  }
  for (const [section, members] of Object.entries(config.sections ?? {})) {
    if (!NAME_RE.test(section)) {
      throw new Error(`createFlowKit: invalid section name "${section}"`)
    }
    if (section in groups) {
      throw new Error(
        `createFlowKit: section "${section}" collides with a target name`,
      )
    }
    for (const member of members) {
      if (!targetNames.includes(member)) {
        throw new Error(
          `createFlowKit: section "${section}" lists unknown target "${member}"`,
        )
      }
    }
    groups[section] = members
  }

  const commands = config.commands ?? {}
  const runnerTool = commands.runnerTool ?? "Bash"
  const targets = {} as { [K in Names]: RenderTarget }
  for (const name of targetNames) {
    const spec = config.targets[name]
    const target: Target = { ...spec, name }
    const sections: Record<string, boolean> = {}
    for (const [section, members] of Object.entries(groups)) {
      sections[section] = members.includes(name)
    }
    const tableIntro = commands.tableIntro
    targets[name] = {
      ...target,
      sections,
      invokeCommand: (command) =>
        commands.invoke?.(command, target) ?? command.file,
      commandsTableIntro:
        typeof tableIntro === "function"
          ? tableIntro(target)
          : (tableIntro ?? `**CLI commands** available via \`${runnerTool}\`:`),
      commandRunnerTool: runnerTool,
    }
  }

  const reservedTokenNames = new Set<string>()
  for (const name of targetNames) {
    for (const token of Object.keys(config.targets[name].tokens)) {
      reservedTokenNames.add(token)
    }
  }
  const schemaOptions: FlowSchemaOptions = {
    targetNames,
    reservedTokenNames: [...reservedTokenNames],
  }
  const schema = createFlowSchema(schemaOptions)

  const getTarget = (name: Names): RenderTarget => {
    const target = targets[name]
    if (target === undefined) {
      throw new Error(
        `Unknown target "${name}". Known targets: ${targetNames.join(", ")}.`,
      )
    }
    return target
  }

  return {
    targetNames,
    targets,
    schema,
    defineFlow(input) {
      const result = schema.safeParse(input)
      if (!result.success) {
        const id =
          typeof input === "object" && input !== null && "id" in input
            ? String(input.id)
            : "<unknown>"
        throw new Error(
          `Invalid flow "${id}":\n${z.prettifyError(result.error)}`,
        )
      }
      return result.data
    },
    render: (flow, name) => renderFlow(flow, getTarget(name)),
    renderMarkdown: (flow, name) => renderMarkdown(flow, getTarget(name)),
    renderProject(projects) {
      const out: GeneratedFile[] = []
      for (const { flow, outputs } of projects) {
        for (const name of targetNames) {
          const output = outputs[name]
          if (output === undefined) {
            continue
          }
          for (const file of renderFlow(flow, getTarget(name))) {
            out.push({
              flowId: flow.id,
              target: name,
              kind: file.kind,
              path: resolveOutputPath(output, file),
              content: file.content,
            })
          }
        }
      }
      return out
    },
    renderMermaid,
    describeFlow,
  }
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? "." : path.slice(0, i)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

/** Map a rendered file onto its output path. Exported for custom build layouts. */
export function resolveOutputPath(
  output: OutputPath,
  file: RenderedFile,
): string {
  const main = typeof output === "string" ? output : output.main
  if (file.slug === "") {
    return main
  }
  if (file.kind === "reference") {
    // The orchestrator links `references/<phase>.md` relative to itself.
    return `${dirname(main)}/references/${file.slug}.md`
  }
  if (typeof output !== "string") {
    return output.phase.replace(/\{phase\}/g, file.slug)
  }
  const skillDir = dirname(main)
  if (skillDir === ".") {
    throw new Error(
      `Cannot derive a sub-skill path for phase "${file.slug}" from "${main}"; use { main, phase } output paths.`,
    )
  }
  return `${dirname(skillDir)}/${basename(skillDir)}-${file.slug}/${basename(main)}`
}

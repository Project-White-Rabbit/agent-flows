import { z } from "zod"

const StepIdRef = z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, {
  message: "Step references must use the form 'phase-id/step-id'",
})

const StepLocalId = z.string().regex(/^[a-z0-9-]+$/)
const PhaseId = z.string().regex(/^[a-z0-9-]+$/)

/**
 * A value that may differ per target: either a bare value (every target) or a
 * map keyed by target name with an optional `default` fallback.
 */
export type PerTargetMap<T> = { default?: T } & Record<string, T | undefined>
export type Targetable<T> = T | PerTargetMap<T>

export function resolvePerTarget<T>(
  value: Targetable<T>,
  target: string,
): T | undefined {
  if (typeof value !== "object" || value === null) {
    return value as T
  }
  const map = value as PerTargetMap<T>
  return map[target] ?? map.default
}

export function resolveTargetableString(
  value: Targetable<string>,
  target: string,
  label: string,
): string {
  const resolved = resolvePerTarget(value, target)
  if (resolved === undefined) {
    throw new Error(`Per-target value missing for ${target}: ${label}`)
  }
  return resolved
}

/**
 * Per-mode conditional sections: `{{#mode:explain}}…{{/mode:explain}}` and the
 * inverse `{{^mode:explain}}…{{/mode:explain}}`. Unlike target sections, which
 * always resolve statically (one file per target), a mode section resolves
 * statically only when the file it lands in is reachable in a single mode; a
 * file shared by several modes keeps the content behind a rendered gate,
 * because one file serves every mode that dispatches into it.
 */
export const MODE_SECTION_RE = /\{\{([#^])mode:([a-z0-9-]+)\}\}/g
export const MODE_SECTION_CLOSE_RE = /\{\{\/mode:([a-z0-9-]+)\}\}/g

// Kept identical to the renderer's resolution regexes so the collector can't
// drift from what the renderer substitutes (e.g. hyphens are allowed).
export const TOOL_PLACEHOLDER_RE = /\{\{tool:([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g
export const COMMAND_PLACEHOLDER_RE =
  /\{\{command:([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g
export const TABLE_PLACEHOLDER_RE =
  /\{\{(table|list):([a-zA-Z][a-zA-Z0-9_-]*):([a-zA-Z0-9_,-]+)\}\}/g

/** Names the schema needs to validate per-target values and token collisions. */
export interface FlowSchemaOptions {
  /** Every target the flow may render for. */
  targetNames: readonly string[]
  /** Token names provided by targets; flow variables may not shadow them. */
  reservedTokenNames?: readonly string[]
}

const NextRef = StepIdRef.nullable()

/**
 * Mode-aware dispatch. Each declared mode must have an entry; missing modes
 * are caught by `superRefine` so the schema enforces exhaustive routing.
 *
 * Use the linear `NextRef` form (a step id string or null) when every mode
 * goes to the same place - that's the common case and keeps the data clean.
 * Switch to `byMode` only at the points where the modes actually diverge.
 */
const ByModeNext = z.object({
  byMode: z.record(z.string(), NextRef),
})

const Next = z.union([NextRef, ByModeNext])

const EmitLabel = z.union([
  z.string(),
  z.object({
    displayName: z.string(),
    action: z.enum(["started", "completed"]),
  }),
])

const BranchOption = z.object({
  /** Letter shown in the choice prompt, e.g. "A", "B", "C". */
  letter: z.string().min(1),
  /** Bolded option name, e.g. "Update all N outdated workspaces". */
  label: z.string().min(1),
  /** Optional explanation that follows the label. */
  description: z.string().optional(),
})

const CompileMode = z.enum(["monolith", "split", "split-chain"])

/**
 * Per-target value: bare, or a map keyed by target name plus `default`. Key
 * validation needs the kit's target names, so it runs in `createFlowSchema`.
 */
function PerTarget<T extends z.ZodTypeAny>(inner: T) {
  return z.union([inner, z.record(z.string(), inner)])
}

const TargetableString = PerTarget(z.string())
const TargetableNonEmptyString = PerTarget(z.string().min(1))

const Base = z.object({
  id: StepLocalId,
  title: TargetableNonEmptyString,
  /**
   * Concise inline name for cross-phase prose references via
   * `{{step-ref:phase/id}}`. Falls back to `title` when omitted. Unlike
   * `{{step:...}}` (a file-local number), `{{step-ref:...}}` renders a stable
   * name, so it stays meaningful across phases and across split-unit files.
   */
  refName: TargetableNonEmptyString.optional(),
  body: TargetableString,
  /**
   * Value emitted through the flow-level `emitTemplate` when this step is
   * reached. String shorthand = display name with action "started".
   * Steps with `emit` but no flow-level template are silently ignored.
   */
  emit: EmitLabel.optional(),
  /**
   * Logical ids of tools this step calls (must exist in `flow.tools`). Used
   * to auto-derive `frontmatter.allowedTools`.
   */
  toolCalls: z.array(z.string()).optional(),
  /** Logical ids of commands this step invokes (must exist in `flow.commands`). */
  commandCalls: z.array(z.string()).optional(),
  /**
   * In a "headers" phase, number the step "0" instead of joining the
   * 1-indexed sequence. For setup-style preambles that sit before step 1.
   */
  preamble: z.boolean().optional(),
  /** Appendix ids this step consults (validated against `flow.appendices`). */
  refs: z.array(z.string().min(1)).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
})

const Action = Base.extend({
  kind: z.literal("action"),
  next: Next,
})

const Branch = Base.extend({
  kind: z.literal("branch"),
  branches: z
    .array(
      z
        .object({
          /**
           * Runtime condition (agent decides). Required unless the branch
           * is a user choice (`option`); also the diagram edge label.
           */
          when: z.string().optional(),
          /** Where this branch goes; linear or `byMode`. */
          next: Next,
          /** Marks the option the agent should default to. */
          recommended: z.boolean().optional(),
          /**
           * Tags the prompt this option belongs to when one step exposes
           * several user prompts; render a subset with `{{branches:name}}`.
           */
          prompt: z.string().optional(),
          /** User-choice option rendered by `{{branches}}`. */
          option: BranchOption.optional(),
          /**
           * Action text for runtime (`when`) branches in `{{whens}}`. Falls
           * back to "stop the flow" (`next: null`) or "continue".
           */
          description: z.string().optional(),
        })
        .strict()
        .refine((b) => b.when !== undefined || b.option !== undefined, {
          message: "branch must define `when` or `option`",
        }),
    )
    .min(2),
})

const Loop = Base.extend({
  kind: z.literal("loop"),
  backTo: StepIdRef,
  exitWhen: z.string().min(1),
  onExit: StepIdRef,
})

const Reference = Base.extend({
  kind: z.literal("reference"),
  refs: z.array(z.string().min(1)).min(1),
  next: Next,
})

const Parallel = Base.extend({
  kind: z.literal("parallel"),
  branches: z
    .array(
      z.object({
        label: z.string().min(1),
        body: z.string(),
      }),
    )
    .min(2),
  next: Next,
})

const Step = z.discriminatedUnion("kind", [
  Action,
  Branch,
  Loop,
  Reference,
  Parallel,
])

const Phase = z.object({
  id: PhaseId,
  title: TargetableNonEmptyString,
  intro: TargetableString.optional(),
  steps: z.array(Step).min(1),
  outro: TargetableString.optional(),
  /**
   * - "list": `## {title}`, intro, then steps as a numbered markdown list.
   * - "headers": title hidden; each step is its own `## {N}. {title}` section.
   */
  stepStyle: z.enum(["list", "headers"]).default("list"),
})

const Appendix = z.object({
  id: z.string().min(1),
  title: TargetableNonEmptyString,
  body: TargetableString,
})

const Frontmatter = z.object({
  description: TargetableNonEmptyString,
  /**
   * A literal invocation hint, or a mode-derived hint with an optional
   * free-form suffix for operands not represented by flow entries.
   */
  argumentHint: z
    .union([
      TargetableString,
      z.object({
        deriveFromModes: z.literal(true),
        suffix: TargetableString.optional(),
      }),
    ])
    .optional(),
  model: z.string().optional(),
  /**
   * Manual override. When omitted and `flow.tools` is non-empty, the
   * renderer derives the list from the tools the flow actually calls.
   */
  allowedTools: z.array(z.string()).optional(),
})

/**
 * One tool the flow can call, referenced by logical id via `step.toolCalls`
 * and `{{tool:id}}`. MCP tools get the target's `mcpPrefix` at render time.
 * `targets` scopes a tool to the hosts that have it; a `{{tool:id}}` that
 * reaches any other target's prose throws, so gate it behind a section.
 */
const ToolDef = z.object({
  name: PerTarget(z.string()),
  kind: z.enum(["builtin", "mcp"]),
  targets: z.array(z.string()).nonempty().optional(),
})

/**
 * One CLI command the flow can invoke. `{{command:id}}` renders through the
 * kit's command invocation; a non-empty registry also emits a reference
 * table after the flow intro.
 */
const CommandDef = z.object({
  file: z.string().min(1),
  description: z.string().min(1),
  args: z.string().optional(),
})

/**
 * Reusable tabular data rendered with `{{table:name:col1,col2}}` (markdown
 * table keyed by `row.key`) or `{{list:name:col}}` (bullets of
 * `label: value`). A row missing any requested column is skipped.
 */
const Table = z.object({
  /** Header of the leading key column. */
  keyHeader: z.string().min(1).default("Name"),
  /** Column header per field; unset fields fall back to the title-cased field name. */
  columns: z.record(z.string(), z.string()).default({}),
  rows: z
    .array(
      z.object({
        key: z.string().min(1),
        /** Display name for `{{list:...}}`; falls back to `key`. */
        label: z.string().optional(),
        cells: z.record(z.string(), z.string()),
      }),
    )
    .min(1),
})

export const FlowBase = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: TargetableNonEmptyString,
  frontmatter: Frontmatter,
  intro: TargetableString.optional(),
  /**
   * Entry step per invocation mode: a bare step id, or a per-target map so a
   * target can start elsewhere (e.g. at a host-specific preamble).
   */
  entries: z.record(z.string(), PerTarget(StepIdRef)),
  /** Mode invoked when the user passes no argument. Must be a key in `entries`. */
  defaultMode: z.string().optional(),
  /**
   * One-line description per mode. Declaring any opts a multi-mode flow
   * into an auto-generated "Modes" routing table.
   */
  modeHints: z.record(z.string(), TargetableString).default({}),
  /**
   * Template rendered for each step `emit`. `{action}` and `{displayName}`
   * are substituted; every other placeholder resolves normally.
   */
  emitTemplate: TargetableString.optional(),
  phases: z.array(Phase).min(1),
  appendices: z.array(Appendix).default([]),
  invariants: z.array(z.string()).default([]),
  tables: z.record(z.string(), Table).default({}),
  tools: z.record(z.string(), ToolDef).default({}),
  commands: z.record(z.string(), CommandDef).default({}),
  /**
   * User-defined `{{name}}` variables (bare or per-target). Must not collide
   * with target token names.
   */
  variables: z.record(z.string(), TargetableString).default({}),
  /**
   * How the flow compiles to files.
   * - `monolith`: one skill file per target.
   * - `split`: an orchestrator plus one sub-skill per non-inline phase,
   *   dispatched call-and-return ("invoke X, then return here").
   * - `split-chain`: same layout, tail-call routing. Every step whose edge
   *   crosses a file boundary gets a generated "**Next:**" block with mode
   *   literals baked in. Targets with `phaseReferences` emit phases as
   *   reference files instead of discoverable sub-skills.
   *
   * `mode` is per-target, so split can roll out one host at a time.
   * `continuousStepNumbers` (monolith only) numbers headers 1…N across
   * sequential phases instead of restarting per phase.
   */
  compile: z
    .object({
      mode: PerTarget(CompileMode).default("monolith"),
      inlinePhases: z.array(z.string()).default([]),
      continuousStepNumbers: z.boolean().default(false),
    })
    .default({
      mode: "monolith",
      inlinePhases: [],
      continuousStepNumbers: false,
    }),
})

/**
 * Build the validating flow schema for a set of targets. On top of the
 * structural schema it checks graph integrity (edges, reachability, exhaustive
 * `byMode` routing), registry references, split-chain shape, and that every
 * per-target map names only known targets and covers each one (or sets
 * `default`).
 */
export function createFlowSchema(options: FlowSchemaOptions) {
  const targetNames = [...options.targetNames]
  const reservedTokenNames = new Set([
    ...(options.reservedTokenNames ?? []),
    "argsToken",
  ])
  const allowedKeys = new Set(["default", ...targetNames])

  return FlowBase.superRefine((flow, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message })

    for (const { path, value } of targetableFields(flow)) {
      if (typeof value !== "object" || value === null) {
        continue
      }
      const map = value as Record<string, unknown>
      for (const key of Object.keys(map)) {
        if (!allowedKeys.has(key)) {
          issue(
            path,
            `Unknown target "${key}" in per-target object. Known targets: ${targetNames.join(", ")}.`,
          )
        }
      }
      if (
        map.default === undefined &&
        !targetNames.every((target) => map[target] !== undefined)
      ) {
        issue(
          path,
          `Per-target object must have \`default\` or define all of ${targetNames.join("/")}.`,
        )
      }
    }

    const allStepIds = new Set<string>()
    const phaseIds = new Set<string>()

    for (const phase of flow.phases) {
      if (phaseIds.has(phase.id)) {
        issue(["phases", phase.id], `duplicate phase id "${phase.id}"`)
      }
      phaseIds.add(phase.id)

      const localIds = new Set<string>()
      for (const step of phase.steps) {
        if (localIds.has(step.id)) {
          issue(
            ["phases", phase.id, "steps"],
            `duplicate step id "${step.id}" in phase "${phase.id}"`,
          )
        }
        localIds.add(step.id)
        allStepIds.add(`${phase.id}/${step.id}`)
      }
    }

    for (const phaseId of flow.compile.inlinePhases) {
      if (!phaseIds.has(phaseId)) {
        issue(
          ["compile", "inlinePhases"],
          `inlinePhases lists unknown phase "${phaseId}"`,
        )
      }
    }

    const declaredModes = Object.keys(flow.entries)
    const declaredModeSet = new Set(declaredModes)
    const argumentHint = flow.frontmatter.argumentHint
    const argumentHintModes = declaredModes.filter(
      (mode) => mode !== "default" || flow.defaultMode !== "default",
    )

    if (
      typeof argumentHint === "object" &&
      "deriveFromModes" in argumentHint &&
      argumentHintModes.length === 0
    ) {
      issue(
        ["frontmatter", "argumentHint"],
        "deriveFromModes requires at least one non-default mode in entries",
      )
    }

    if (
      flow.defaultMode !== undefined &&
      !declaredModeSet.has(flow.defaultMode)
    ) {
      issue(
        ["defaultMode"],
        `defaultMode "${flow.defaultMode}" not declared in entries`,
      )
    }

    for (const mode of Object.keys(flow.modeHints)) {
      if (!declaredModeSet.has(mode)) {
        issue(
          ["modeHints", mode],
          `modeHints key "${mode}" not declared in entries`,
        )
      }
    }

    for (const phase of flow.phases) {
      for (const step of phase.steps) {
        for (const ref of refsFromStep(step)) {
          if (!allStepIds.has(ref)) {
            issue(
              ["phases", phase.id, "steps", step.id],
              `edge → unknown step "${ref}"`,
            )
          }
        }

        const validateByMode = (
          byMode: Record<string, string | null>,
          path: (string | number)[],
          label: string,
        ): void => {
          for (const mode of Object.keys(byMode)) {
            if (!declaredModeSet.has(mode)) {
              issue(
                path,
                `${label} lists mode "${mode}" not declared in flow.entries`,
              )
            }
          }
          const missingModes = declaredModes.filter((m) => !(m in byMode))
          if (missingModes.length > 0) {
            issue(
              path,
              `${label} byMode is missing entries for mode(s): ${missingModes.join(", ")}`,
            )
          }
        }

        if (
          (step.kind === "action" ||
            step.kind === "reference" ||
            step.kind === "parallel") &&
          typeof step.next === "object" &&
          step.next !== null
        ) {
          validateByMode(
            step.next.byMode,
            ["phases", phase.id, "steps", step.id, "next", "byMode"],
            `step "${step.id}" next`,
          )
        }

        if (step.kind === "branch") {
          for (const [i, branch] of step.branches.entries()) {
            if (typeof branch.next === "object" && branch.next !== null) {
              const branchLabelText =
                branch.option !== undefined
                  ? `option "${branch.option.letter}"`
                  : (branch.when ?? `branch[${i}]`)
              validateByMode(
                branch.next.byMode,
                [
                  "phases",
                  phase.id,
                  "steps",
                  step.id,
                  "branches",
                  i,
                  "next",
                  "byMode",
                ],
                `step "${step.id}" branch ${branchLabelText}`,
              )
            }
          }
        }
      }
    }

    // At most one preamble step per phase - several would all render as
    // `## 0.` and produce duplicate headers.
    for (const phase of flow.phases) {
      const preambleCount = phase.steps.filter(
        (s) => s.preamble === true,
      ).length
      if (preambleCount > 1) {
        issue(
          ["phases", phase.id, "steps"],
          `phase "${phase.id}" has ${preambleCount} preamble steps; only one is allowed per phase`,
        )
      }
    }

    const appendixIds = new Set(flow.appendices.map((a) => a.id))
    for (const phase of flow.phases) {
      for (const step of phase.steps) {
        for (const r of step.refs ?? []) {
          if (!appendixIds.has(r)) {
            issue(
              ["phases", phase.id, "steps", step.id, "refs"],
              `unknown appendix "${r}"`,
            )
          }
        }
      }
    }

    for (const [mode, entry] of Object.entries(flow.entries)) {
      for (const target of targetNames) {
        const resolved = resolvePerTarget(entry, target)
        if (resolved === undefined) {
          issue(
            ["entries", mode],
            `entry for mode "${mode}" has no value for target "${target}" (and no default)`,
          )
          continue
        }
        if (!allStepIds.has(resolved)) {
          issue(
            ["entries", mode],
            `entry "${mode}" → "${target}" → unknown step "${resolved}"`,
          )
        }
      }
    }

    // A step is OK if reachable in at least one (mode, target).
    const reachableUnion = new Set<string>()
    for (const target of targetNames) {
      for (const id of computeReachableSteps(flow, target)) {
        reachableUnion.add(id)
      }
    }
    for (const id of allStepIds) {
      if (!reachableUnion.has(id)) {
        issue(
          ["phases"],
          `unreachable step "${id}" in any (mode, target) combination`,
        )
      }
    }

    // split-chain structural guards, per target that compiles chain-style:
    //
    //   1. A mode entry may not point mid-way into a non-inline phase. A
    //      sub-skill always starts at its first step.
    //   2. A sub-skill step may not route back into an inline phase. That is
    //      "re-enter the orchestrator", exactly what chain dispatch removes.
    //      Model the shared work as its own (terminal) phase instead.
    const inlinePhaseSet = new Set(flow.compile.inlinePhases)
    const phaseOf = (ref: string): string => ref.split("/")[0] as string
    for (const target of targetNames) {
      if (resolvePerTarget(flow.compile.mode, target) !== "split-chain") {
        continue
      }
      for (const [mode, entry] of Object.entries(flow.entries)) {
        const resolved = resolvePerTarget(entry, target)
        if (resolved === undefined || !allStepIds.has(resolved)) {
          continue
        }
        const entryPhase = phaseOf(resolved)
        if (inlinePhaseSet.has(entryPhase)) {
          continue
        }
        const firstStep = flow.phases.find((p) => p.id === entryPhase)?.steps[0]
        if (
          firstStep !== undefined &&
          resolved !== `${entryPhase}/${firstStep.id}`
        ) {
          issue(
            ["entries", mode],
            `split-chain: entry "${mode}" → "${target}" points mid-phase at "${resolved}"; a sub-skill starts at its first step ("${entryPhase}/${firstStep.id}"). Reorder the phase or inline it.`,
          )
        }
      }
      const reachable = computeReachableSteps(flow, target)
      for (const phase of flow.phases) {
        if (inlinePhaseSet.has(phase.id)) {
          continue
        }
        for (const step of phase.steps) {
          if (!reachable.has(`${phase.id}/${step.id}`)) {
            continue
          }
          for (const ref of refsFromStep(step)) {
            if (inlinePhaseSet.has(phaseOf(ref))) {
              issue(
                ["phases", phase.id, "steps", step.id],
                `split-chain: step "${phase.id}/${step.id}" routes to "${ref}" in inline phase "${phaseOf(ref)}" (target "${target}"). Sub-skills may not re-enter the orchestrator; make the shared work its own phase.`,
              )
            }
          }
        }
      }
    }

    const toolIds = new Set(Object.keys(flow.tools))
    const commandIds = new Set(Object.keys(flow.commands))
    const knownTargets = new Set(targetNames)
    for (const [toolId, tool] of Object.entries(flow.tools)) {
      for (const t of tool.targets ?? []) {
        if (!knownTargets.has(t)) {
          issue(
            ["tools", toolId, "targets"],
            `tool "${toolId}" lists unknown target "${t}"`,
          )
        }
      }
    }
    for (const phase of flow.phases) {
      for (const step of phase.steps) {
        for (const toolId of step.toolCalls ?? []) {
          if (!toolIds.has(toolId)) {
            issue(
              ["phases", phase.id, "steps", step.id, "toolCalls"],
              `step "${step.id}" calls tool "${toolId}" not declared in flow.tools`,
            )
          }
        }
        for (const cmdId of step.commandCalls ?? []) {
          if (!commandIds.has(cmdId)) {
            issue(
              ["phases", phase.id, "steps", step.id, "commandCalls"],
              `step "${step.id}" calls command "${cmdId}" not declared in flow.commands`,
            )
          }
        }
      }
    }

    for (const { location, text } of flowTexts(flow)) {
      for (const match of text.matchAll(COMMAND_PLACEHOLDER_RE)) {
        if (!commandIds.has(match[1] as string)) {
          issue(
            ["commands"],
            `{{command:${match[1]}}} in ${location} not declared in flow.commands`,
          )
        }
      }
      for (const match of text.matchAll(TOOL_PLACEHOLDER_RE)) {
        if (!toolIds.has(match[1] as string)) {
          issue(
            ["tools"],
            `{{tool:${match[1]}}} in ${location} not declared in flow.tools`,
          )
        }
      }
      for (const match of text.matchAll(TABLE_PLACEHOLDER_RE)) {
        if (flow.tables[match[2] as string] === undefined) {
          issue(
            ["tables"],
            `{{${match[1]}:${match[2]}:…}} in ${location} names an undeclared table`,
          )
        }
      }
      for (const match of text.matchAll(MODE_SECTION_RE)) {
        if (!declaredModeSet.has(match[2] as string)) {
          issue(
            ["phases"],
            `{{${match[1]}mode:${match[2]}}} in ${location} names a mode that does not exist. Declared modes: ${[...declaredModeSet].sort().join(", ")}.`,
          )
        }
      }
      for (const match of text.matchAll(MODE_SECTION_CLOSE_RE)) {
        if (!declaredModeSet.has(match[1] as string)) {
          issue(
            ["phases"],
            `{{/mode:${match[1]}}} in ${location} closes a mode that does not exist. Declared modes: ${[...declaredModeSet].sort().join(", ")}.`,
          )
        }
      }
    }

    for (const name of Object.keys(flow.variables)) {
      if (reservedTokenNames.has(name)) {
        issue(
          ["variables", name],
          `variable "${name}" collides with the target token of the same name`,
        )
      }
    }
  })
}

export type Flow = z.output<typeof FlowBase>
export type FlowInput = z.input<typeof FlowBase>
export type Phase = Flow["phases"][number]
export type Step = Phase["steps"][number]
export type Appendix = Flow["appendices"][number]
export type Table = Flow["tables"][string]
export type BranchOption = NonNullable<
  Extract<Step, { kind: "branch" }>["branches"][number]["option"]
>

type Next = string | null | { byMode: Record<string, string | null> }

function refsFromNext(next: Next): string[] {
  if (next === null) {
    return []
  }
  if (typeof next === "string") {
    return [next]
  }
  return Object.values(next.byMode).filter(
    (v): v is string => typeof v === "string",
  )
}

function refsFromStep(s: Step): string[] {
  switch (s.kind) {
    case "action":
    case "reference":
    case "parallel":
      return refsFromNext(s.next)
    case "branch":
      return s.branches.flatMap((b) => refsFromNext(b.next))
    case "loop":
      return [s.backTo, s.onExit]
  }
}

/** Every variant of a targetable string (bare value or each per-target entry). */
function variants(value: Targetable<string> | undefined): string[] {
  if (value === undefined) {
    return []
  }
  if (typeof value === "string") {
    return [value]
  }
  return Object.values(value).filter((v): v is string => v !== undefined)
}

/**
 * Every prose field the renderer emits, across all target variants, labeled
 * with its location. Shared by the schema's placeholder validation and the
 * tool collector so new text fields only need registering once.
 */
export function flowTexts(
  flow: Flow,
): { location: string; text: string; phaseId?: string }[] {
  const out: { location: string; text: string; phaseId?: string }[] = []
  const push = (
    location: string,
    value: Targetable<string> | undefined,
    phaseId?: string,
  ) => {
    for (const text of variants(value)) {
      out.push({ location, text, phaseId })
    }
  }
  push("flow.intro", flow.intro)
  push("flow.emitTemplate", flow.emitTemplate)
  for (const inv of flow.invariants) {
    push("flow.invariants", inv)
  }
  for (const [name, value] of Object.entries(flow.variables)) {
    push(`variable "${name}"`, value)
  }
  for (const phase of flow.phases) {
    push(`phase "${phase.id}" intro`, phase.intro, phase.id)
    push(`phase "${phase.id}" outro`, phase.outro, phase.id)
    for (const step of phase.steps) {
      const where = `step "${phase.id}/${step.id}"`
      push(where, step.body, phase.id)
      if (step.kind === "branch") {
        for (const branch of step.branches) {
          push(where, branch.description, phase.id)
        }
      }
      if (step.kind === "parallel") {
        for (const branch of step.branches) {
          push(where, branch.body, phase.id)
        }
      }
    }
  }
  for (const appendix of flow.appendices) {
    push(`appendix "${appendix.id}"`, appendix.body)
  }
  return out
}

/**
 * Tool logical-ids the flow calls, in registry order: every `step.toolCalls`
 * plus `{{tool:ID}}` references in any emitted text. A tool mentioned only in
 * intro prose must still land in `allowed-tools` or the host blocks the call.
 */
export function collectCalledToolIds(flow: Flow): string[] {
  const called = new Set<string>()
  for (const phase of flow.phases) {
    for (const step of phase.steps) {
      for (const id of step.toolCalls ?? []) {
        called.add(id)
      }
    }
  }
  for (const { text } of flowTexts(flow)) {
    for (const match of text.matchAll(TOOL_PLACEHOLDER_RE)) {
      called.add(match[1] as string)
    }
  }
  return Object.keys(flow.tools).filter((id) => called.has(id))
}

/** Command logical-ids invoked via `step.commandCalls`, in registry order. */
export function collectCalledCommandIds(flow: Flow): string[] {
  const called = new Set<string>()
  for (const phase of flow.phases) {
    for (const step of phase.steps) {
      for (const id of step.commandCalls ?? []) {
        called.add(id)
      }
    }
  }
  return Object.keys(flow.commands).filter((id) => called.has(id))
}

/**
 * Next step(s) reachable from `step` in `mode`. Branch and loop kinds return
 * every outgoing edge; `byMode` nexts return the mode's target (missing = end).
 */
export function nextRefsForMode(step: Step, mode: string): (string | null)[] {
  switch (step.kind) {
    case "action":
    case "reference":
    case "parallel":
      if (step.next === null || typeof step.next === "string") {
        return [step.next]
      }
      return [step.next.byMode[mode] ?? null]
    case "branch":
      return step.branches.map((b) => {
        if (b.next === null || typeof b.next === "string") {
          return b.next
        }
        return b.next.byMode[mode] ?? null
      })
    case "loop":
      return [step.backTo, step.onExit]
  }
}

export function computeReachableSteps(flow: Flow, target: string): Set<string> {
  return new Set(computeModesPerStep(flow, target).keys())
}

/** For one target, the set of modes that reach each step. */
export function computeModesPerStep(
  flow: Flow,
  target: string,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  const stepById = new Map<string, Step>()
  for (const phase of flow.phases) {
    for (const step of phase.steps) {
      stepById.set(`${phase.id}/${step.id}`, step)
    }
  }

  for (const [mode, entry] of Object.entries(flow.entries)) {
    const start = resolvePerTarget(entry, target)
    if (start === undefined) {
      continue
    }
    const queue: string[] = [start]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const id = queue.shift()
      if (id === undefined || seen.has(id)) {
        continue
      }
      seen.add(id)
      const set = result.get(id) ?? new Set<string>()
      set.add(mode)
      result.set(id, set)
      const step = stepById.get(id)
      if (step === undefined) {
        continue
      }
      for (const n of nextRefsForMode(step, mode)) {
        if (n !== null) {
          queue.push(n)
        }
      }
    }
  }

  return result
}

/** Diagram edge label for a branch: from `option` when present, else `when`. */
export function branchLabel(branch: {
  when?: string
  option?: { letter: string; label: string }
}): string {
  if (branch.option !== undefined) {
    return `${branch.option.letter} - ${branch.option.label}`
  }
  if (branch.when !== undefined) {
    return branch.when
  }
  return "(unlabeled branch)"
}

/** Every per-target-capable field in a flow, with its path for error reporting. */
function targetableFields(
  flow: Flow,
): { path: (string | number)[]; value: unknown }[] {
  const out: { path: (string | number)[]; value: unknown }[] = []
  const push = (path: (string | number)[], value: unknown) => {
    if (value !== undefined) {
      out.push({ path, value })
    }
  }
  push(["title"], flow.title)
  push(["intro"], flow.intro)
  push(["emitTemplate"], flow.emitTemplate)
  push(["frontmatter", "description"], flow.frontmatter.description)
  const hint = flow.frontmatter.argumentHint
  if (typeof hint === "object" && hint !== null && "deriveFromModes" in hint) {
    push(["frontmatter", "argumentHint", "suffix"], hint.suffix)
  } else {
    push(["frontmatter", "argumentHint"], hint)
  }
  push(["compile", "mode"], flow.compile.mode)
  for (const [mode, entry] of Object.entries(flow.entries)) {
    push(["entries", mode], entry)
  }
  for (const [mode, value] of Object.entries(flow.modeHints)) {
    push(["modeHints", mode], value)
  }
  for (const [name, value] of Object.entries(flow.variables)) {
    push(["variables", name], value)
  }
  for (const [id, tool] of Object.entries(flow.tools)) {
    push(["tools", id, "name"], tool.name)
  }
  for (const phase of flow.phases) {
    push(["phases", phase.id, "title"], phase.title)
    push(["phases", phase.id, "intro"], phase.intro)
    push(["phases", phase.id, "outro"], phase.outro)
    for (const step of phase.steps) {
      const base = ["phases", phase.id, "steps", step.id]
      push([...base, "title"], step.title)
      push([...base, "refName"], step.refName)
      push([...base, "body"], step.body)
    }
  }
  for (const appendix of flow.appendices) {
    push(["appendices", appendix.id, "title"], appendix.title)
    push(["appendices", appendix.id, "body"], appendix.body)
  }
  return out
}

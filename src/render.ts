import {
  COMMAND_PLACEHOLDER_RE,
  collectCalledToolIds,
  computeModesPerStep,
  computeReachableSteps,
  type Flow,
  MODE_SECTION_RE,
  type Phase,
  resolvePerTarget,
  resolveTargetableString,
  type Step,
  TOOL_PLACEHOLDER_RE,
} from "./schema.js"
import type { Target } from "./targets.js"

type TargetName = string

/** A command registry entry as declared in `flow.commands`. */
export type CommandDef = Flow["commands"][string]

/**
 * A target bound to its kit: section membership and command conventions are
 * resolved once by `createFlowKit` so the renderer stays a pure function.
 */
export interface RenderTarget extends Target {
  /** Every known section name → whether this target keeps its content. */
  sections: Readonly<Record<string, boolean>>
  /** Render a `{{command:id}}` invocation. */
  invokeCommand: (command: CommandDef) => string
  /** Markdown preceding the generated command reference table. */
  commandsTableIntro: string
  /** Builtin tool that runs commands; implied by any command use for `allowed-tools`. */
  commandRunnerTool: string
}

function s(
  value: Parameters<typeof resolveTargetableString>[0],
  target: TargetName,
  label: string,
): string {
  return resolveTargetableString(value, target, label)
}

/** One generated skill or phase reference for a (flow, target) pair. */
export interface RenderedFile {
  /**
   * Path-suffix the output config resolves against. Empty for the monolith
   * file and the split orchestrator; the phase id for a sub-skill or reference.
   */
  slug: string
  kind: "monolith" | "orchestrator" | "phase" | "reference"
  content: string
}

/**
 * Render a flow to one or more skill files for a target.
 *
 * - `monolith` (default): a single file from `renderMarkdown` (unchanged).
 * - `split`: an orchestrator (slug `""`) plus one sub-skill per non-inline
 *   phase (slug = phase id). Phases listed in `compile.inlinePhases` stay
 *   inside the orchestrator and emit no sub-skill of their own. The
 *   orchestrator dispatches call-and-return ("invoke X, then return here").
 * - `split-chain`: same file layout, but routing compiles to tail-call
 *   dispatch. No "return here": every step whose outgoing edge crosses a
 *   unit boundary gets a generated "Next:" annotation with baked mode
 *   literals, and control never re-enters the orchestrator.
 *   Targets with `phaseReferences` emit phases as ordinary
 *   `references/<phase>.md` files so they do not become separately
 *   discoverable skills.
 *
 * `compile.mode` is resolved per target, so a flow can split one target while
 * the rest stay monolith (e.g. `{ default: "monolith", claude: "split" }`).
 */
export function renderFlow(flow: Flow, target: RenderTarget): RenderedFile[] {
  const mode = resolvePerTarget(flow.compile.mode, target.name)
  if (mode === "split" || mode === "split-chain") {
    return renderSplit(flow, target, mode === "split-chain")
  }
  return [{ slug: "", kind: "monolith", content: renderMarkdown(flow, target) }]
}

function usesPhaseReferences(flow: Flow, target: RenderTarget): boolean {
  return (
    target.phaseReferences === true &&
    resolvePerTarget(flow.compile.mode, target.name) === "split-chain"
  )
}

/** Shared per-target render context computed once per flow. */
interface RenderContext {
  allModes: string[]
  modesPerStep: Map<string, Set<string>>
  reachable: Set<string>
  emitTemplate: string | undefined
}

function makeRenderContext(flow: Flow, target: RenderTarget): RenderContext {
  return {
    allModes: Object.keys(flow.entries),
    modesPerStep: computeModesPerStep(flow, target.name),
    reachable: computeReachableSteps(flow, target.name),
    emitTemplate:
      flow.emitTemplate !== undefined
        ? s(flow.emitTemplate, target.name, "flow.emitTemplate")
        : undefined,
  }
}

function phaseHasReachableSteps(phase: Phase, reachable: Set<string>): boolean {
  return phase.steps.some((step) => reachable.has(`${phase.id}/${step.id}`))
}

/**
 * Expand a split flow into an orchestrator plus one sub-skill per non-inline
 * phase that has at least one reachable step for this target. Reachability is
 * per-target, so a phase only invokable in (say) Codex modes emits no sub-skill
 * and no dispatch entry for the other targets.
 *
 * `chain` selects tail-call dispatch (`split-chain`): no per-phase dispatch
 * sections in the orchestrator; instead cross-unit edges render as per-step
 * "Next:" annotations and each sub-skill routes onward itself.
 */
function renderSplit(
  flow: Flow,
  target: RenderTarget,
  chain = false,
): RenderedFile[] {
  const ctx = makeRenderContext(flow, target)
  const inlineSet = new Set(flow.compile.inlinePhases)
  const subPhases = flow.phases.filter(
    (phase) =>
      !inlineSet.has(phase.id) && phaseHasReachableSteps(phase, ctx.reachable),
  )

  const files: RenderedFile[] = [
    {
      slug: "",
      kind: "orchestrator",
      content: renderOrchestrator(
        flow,
        target,
        ctx,
        inlineSet,
        subPhases,
        chain,
      ),
    },
  ]
  for (const phase of subPhases) {
    files.push({
      slug: phase.id,
      kind: usesPhaseReferences(flow, target) ? "reference" : "phase",
      content: renderSubSkill(flow, target, ctx, phase, chain),
    })
  }
  return files
}

// ---------------------------------------------------------------------------
// Chain dispatch (split-chain): cross-unit edge computation + "Next:" rendering
// ---------------------------------------------------------------------------

/**
 * A **unit** is the set of phases compiled into one file: all inline phases
 * for the orchestrator, a single phase for a sub-skill. An edge is cross-unit
 * when its target phase lies outside the source step's unit; those edges
 * become generated "Next:" lines on the source step.
 */
type DispatchKind = "dispatch" | "done" | "continue"

interface DispatchEdge {
  /** Branch/loop label naming the route, or null for the step's own next. */
  label: string | null
  kind: DispatchKind
  /** Phase id the edge dispatches to; null for done/continue. */
  targetPhase: string | null
  /** Modes (in declaration order) that take this edge. */
  modes: string[]
}

/**
 * Outgoing (label, ref) pairs for a step in one mode. Labels distinguish a
 * step's multiple routes in the generated Next lines: branch options/whens
 * and the loop's exit condition ("otherwise" for the loop-back edge).
 * Mirrors `nextRefsForMode` but keeps the route's name attached.
 */
function labeledRefsForMode(
  step: Step,
  mode: string,
): { label: string | null; ref: string | null }[] {
  switch (step.kind) {
    case "action":
    case "reference":
    case "parallel": {
      const next = step.next
      const ref =
        next === null || typeof next === "string"
          ? next
          : (next.byMode[mode] ?? null)
      return [{ label: null, ref }]
    }
    case "branch":
      return step.branches.map((branch) => {
        const next = branch.next
        const ref =
          next === null || typeof next === "string"
            ? next
            : (next.byMode[mode] ?? null)
        return { label: dispatchBranchLabel(branch), ref }
      })
    case "loop":
      return [
        { label: step.exitWhen, ref: step.onExit },
        { label: "otherwise", ref: step.backTo },
      ]
  }
}

function dispatchBranchLabel(branch: {
  when?: string
  option?: { letter: string; label: string }
}): string {
  if (branch.option !== undefined) {
    return `option ${branch.option.letter} (${branch.option.label})`
  }
  // `superRefine` guarantees `when` is present when `option` is absent.
  return branch.when ?? "branch"
}

/**
 * Cross-unit dispatch edges for one step, grouped by (label, kind, target)
 * with modes merged. Done/continue edges are kept only when a sibling mode of
 * the same label dispatches cross-unit, so the generated lines contrast
 * "invoke X" against "done" / "continue below" explicitly; a label whose
 * every mode stays terminal or in-unit emits nothing (the body's own prose
 * already covers it).
 */
function computeDispatchEdges(
  step: Step,
  stepKey: string,
  unitPhases: Set<string>,
  ctx: RenderContext,
): DispatchEdge[] {
  const stepModeSet = modesForStep(stepKey, ctx.modesPerStep, ctx.allModes)
  const stepModes = ctx.allModes.filter((m) => stepModeSet.has(m))
  const groups = new Map<string, DispatchEdge>()
  const order: string[] = []
  const labelHasDispatch = new Set<string | null>()

  for (const mode of stepModes) {
    for (const { label, ref } of labeledRefsForMode(step, mode)) {
      let kind: DispatchKind = "done"
      let targetPhase: string | null = null
      if (ref !== null) {
        const phaseId = ref.split("/")[0] as string
        if (unitPhases.has(phaseId)) {
          kind = "continue"
        } else {
          kind = "dispatch"
          targetPhase = phaseId
        }
      }
      const key = `${label ?? "\u0000"}|${kind}|${targetPhase ?? ""}`
      const existing = groups.get(key)
      if (existing !== undefined) {
        if (!existing.modes.includes(mode)) {
          existing.modes.push(mode)
        }
      } else {
        groups.set(key, { label, kind, targetPhase, modes: [mode] })
        order.push(key)
      }
      if (kind === "dispatch") {
        labelHasDispatch.add(label)
      }
    }
  }

  return order
    .map((key) => groups.get(key) as DispatchEdge)
    .filter((edge) => labelHasDispatch.has(edge.label))
}

/**
 * Render a step's cross-unit edges as a "**Next:**" block. Mode literals are
 * baked into every line (the orchestrator's dispatch is itself per-mode, so
 * the literal is always known); single-mode flows drop the mode prose
 * entirely. Every dispatch line also forwards the user's non-mode argument
 * (audit scope, PR target, bump names, ...): the mode literal alone does not
 * carry it. It forwards the target's argument token (`target.argsToken`) minus
 * the leading mode keyword, so a keyword mode (`test example ts-langgraph`)
 * hands the sub-skill just the target the mode's section parses, exactly as the
 * monolith did after routing on the first token. Returns null when the step has
 * nothing to dispatch.
 */
function renderDispatchSuffix(
  flow: Flow,
  target: RenderTarget,
  edges: DispatchEdge[],
  allModes: string[],
  unitPhases: Set<string>,
): string | null {
  if (edges.length === 0) {
    return null
  }
  const singleMode = allModes.length === 1
  const lines = edges.map((edge) => {
    const modeList = edge.modes.map((m) => `\`${m}\``).join(" or ")
    let prefix = ""
    if (edge.label !== null) {
      prefix = singleMode
        ? titleCase(edge.label)
        : `${titleCase(edge.label)} (mode ${modeList})`
    } else if (!singleMode) {
      prefix = `Mode ${modeList}`
    }
    let action: string
    switch (edge.kind) {
      case "done":
        action = "stop here."
        break
      case "continue":
        action = usesPhaseReferences(flow, target)
          ? "continue below in this file."
          : "continue below in this skill."
        break
      case "dispatch": {
        if (edge.targetPhase === null) {
          throw new Error("Dispatch edge is missing its target phase")
        }
        const destination = phaseDestination(
          flow,
          target,
          edge.targetPhase,
          unitPhases,
        )
        const actionVerb = usesPhaseReferences(flow, target)
          ? "read and follow"
          : "invoke"
        const fwd = `, forwarding \`${target.argsToken}\` minus the leading mode keyword (if the user typed one).`
        if (singleMode) {
          action = `${actionVerb} ${destination}${fwd}`
        } else if (edge.modes.length === 1) {
          action = `${actionVerb} ${destination} with mode \`${edge.modes[0]}\`${fwd}`
        } else {
          action = `${actionVerb} ${destination} with the current mode (${modeList})${fwd}`
        }
        break
      }
    }
    return prefix.length > 0
      ? `- ${prefix}: ${action}`
      : `- ${titleCase(action)}`
  })
  return `**Next:**\n\n${lines.join("\n")}`
}

/**
 * Names a separately discoverable skill. `phaseReferences` targets instead
 * use file links through `phaseDestination`.
 */
function dispatchSkillRef(target: RenderTarget, skillName: string): string {
  return target.dispatchRef?.(skillName) ?? `\`${skillName}\``
}

function phaseDestination(
  flow: Flow,
  target: RenderTarget,
  phaseId: string,
  unitPhases: Set<string>,
): string {
  if (!usesPhaseReferences(flow, target)) {
    return `the ${dispatchSkillRef(target, `${flow.id}-${phaseId}`)} skill`
  }
  const phase = flow.phases.find((candidate) => candidate.id === phaseId)
  if (phase === undefined) {
    throw new Error(`Unknown phase "${phaseId}" in flow "${flow.id}"`)
  }
  const fromReference = [...unitPhases].some(
    (id) => !flow.compile.inlinePhases.includes(id),
  )
  const prefix = fromReference ? "./" : "references/"
  const title = s(phase.title, target.name, `phase[${phaseId}].title`)
  return `the [${title}](${prefix}${phaseId}.md) reference`
}

/** Per-step dispatch-suffix callback for a unit, handed to `renderPhase`. */
function dispatchSuffixForUnit(
  flow: Flow,
  target: RenderTarget,
  ctx: RenderContext,
  unitPhases: Set<string>,
): (step: Step, stepKey: string) => string | null {
  return (step, stepKey) =>
    renderDispatchSuffix(
      flow,
      target,
      computeDispatchEdges(step, stepKey, unitPhases, ctx),
      ctx.allModes,
      unitPhases,
    )
}

/**
 * Routing pointer for an interactive `default` overview. When a split-chain
 * orchestrator's no-argument mode is an inline step that just shows the mode
 * menu and asks the user to pick (terminal, `next: null`), the modes it offers
 * live in sub-skills reached only through the `## Dispatch` block. That step has
 * no dispatch edge of its own, so without this line the agent renders the menu
 * and then has nothing telling it to route the user's choice into the matching
 * sub-skill (the "self-contained section below" it would scroll to under
 * monolith is gone). Monolith keeps every mode inline under the menu, so it
 * never needs this.
 *
 * The pointer also has to fix the forwarding source. The `## Dispatch` lines
 * forward `target.argsToken` (e.g. `$ARGUMENTS`), but this is the no-argument
 * entry: the user reached the menu precisely because they typed no mode, so
 * `argsToken` is empty and their pick (mode plus any trailing scope, like
 * `local` after `url` or a framework after `example`) arrives in their reply,
 * not in `argsToken`. So the pointer tells the agent to forward the reply's
 * arguments (minus the mode keyword), overriding the dispatch lines' empty
 * `argsToken` on this path.
 */
function interactiveDefaultDispatchPointer(
  flow: Flow,
  target: RenderTarget,
): string {
  const action = usesPhaseReferences(flow, target)
    ? "read and follow that mode's reference"
    : "invoke that mode's skill"
  return `**Next:** once the user picks a mode, ${action} from the \`## Dispatch\` section above, forwarding the arguments the user gave with their pick minus the mode keyword. Ignore the dispatch lines' \`${target.argsToken}\` here: this is the no-argument entry, so it is empty and the user's pick is the only source of those arguments.`
}

/**
 * Orchestrator suffix callback: `dispatchSuffixForUnit`, plus the interactive-
 * default pointer. When the flow emits a `## Dispatch` block (`hasEntryDispatch`)
 * and the inline `default` entry step is terminal (`next: null`, so it has no
 * dispatch edge of its own), append the pointer so the interactive menu's choice
 * still reaches a sub-skill. Every other step keeps the normal suffix.
 */
function orchestratorDispatchSuffix(
  flow: Flow,
  target: RenderTarget,
  ctx: RenderContext,
  inlineSet: Set<string>,
  hasEntryDispatch: boolean,
): (step: Step, stepKey: string) => string | null {
  const base = dispatchSuffixForUnit(flow, target, ctx, inlineSet)
  const defaultEntry =
    flow.entries.default === undefined
      ? undefined
      : resolvePerTarget(flow.entries.default, target.name)
  return (step, stepKey) => {
    if (
      hasEntryDispatch &&
      defaultEntry !== undefined &&
      stepKey === defaultEntry &&
      "next" in step &&
      step.next === null
    ) {
      return interactiveDefaultDispatchPointer(flow, target)
    }
    return base(step, stepKey)
  }
}

/**
 * Modes whose entry step (for this target) lives in a non-inline phase need
 * an explicit dispatch line in the orchestrator: there is no inline content
 * for them to flow through. Modes entering inline phases are routed by the
 * inline steps' own Next annotations. Each dispatch line forwards the target's
 * argument token (`target.argsToken`) minus the leading mode keyword so the
 * sub-skill still sees the user's non-mode argument (scope, PR target, bump
 * names) without the mode token re-injected. Returns null when every mode
 * enters an inline phase (the common case, e.g. a shared setup phase).
 */
function renderEntryDispatch(
  flow: Flow,
  target: RenderTarget,
  ctx: RenderContext,
  inlineSet: Set<string>,
): string | null {
  const groups = new Map<string, string[]>()
  for (const [mode, entry] of Object.entries(flow.entries)) {
    const resolved = resolvePerTarget(entry, target.name)
    if (resolved === undefined) {
      continue
    }
    const phaseId = resolved.split("/")[0] as string
    if (inlineSet.has(phaseId)) {
      continue
    }
    const modes = groups.get(phaseId) ?? []
    modes.push(mode)
    groups.set(phaseId, modes)
  }
  if (groups.size === 0) {
    return null
  }
  const singleMode = ctx.allModes.length === 1
  const lines = [...groups.entries()].map(([phaseId, modes]) => {
    const destination = phaseDestination(flow, target, phaseId, inlineSet)
    const action = usesPhaseReferences(flow, target)
      ? "read and follow"
      : "invoke"
    const fwd = `, forwarding \`${target.argsToken}\` minus the leading mode keyword (if the user typed one).`
    if (singleMode) {
      return `- ${titleCase(action)} ${destination}${fwd}`
    }
    const modeList = modes.map((m) => `\`${m}\``).join(" or ")
    const arg =
      modes.length === 1
        ? `mode \`${modes[0]}\``
        : `the current mode (${modeList})`
    return `- Mode ${modeList}: ${action} ${destination} with ${arg}${fwd}`
  })
  return `## Dispatch\n\n${lines.join("\n")}`
}

/**
 * Appendices belonging to a unit under chain dispatch: those `refs`-referenced
 * by a reachable step inside the unit, plus (orchestrator only) appendices no
 * reachable step references anywhere - flow-global reference material keeps
 * its current home. This keeps terminal sub-skills self-sufficient; the agent
 * never needs to look back at the orchestrator for an appendix.
 */
function appendicesForUnit(
  flow: Flow,
  ctx: RenderContext,
  unitPhases: Set<string>,
  includeUnreferenced: boolean,
): Flow["appendices"] {
  const referencingPhases = new Map<string, Set<string>>()
  for (const phase of flow.phases) {
    for (const step of phase.steps) {
      if (!ctx.reachable.has(`${phase.id}/${step.id}`)) {
        continue
      }
      for (const ref of step.refs ?? []) {
        const phases = referencingPhases.get(ref) ?? new Set<string>()
        phases.add(phase.id)
        referencingPhases.set(ref, phases)
      }
    }
  }
  return flow.appendices.filter((appendix) => {
    const phases = referencingPhases.get(appendix.id)
    if (phases === undefined) {
      return includeUnreferenced
    }
    return [...phases].some((id) => unitPhases.has(id))
  })
}

/**
 * The orchestrator carries the flow's shared chrome (intro, command table,
 * invariants, appendices), renders any inline phases in place, and for each
 * non-inline phase emits a short dispatch section pointing at its sub-skill.
 *
 * Under chain dispatch (`chain = true`) the per-phase dispatch sections are
 * dropped: inline steps carry "Next:" annotations for their own cross-unit
 * edges, modes that enter a sub-phase directly get a `## Dispatch` section,
 * and only inline-referenced (or globally unreferenced) appendices render
 * here - the rest move into the sub-skills that reference them.
 */
function renderOrchestrator(
  flow: Flow,
  target: RenderTarget,
  ctx: RenderContext,
  inlineSet: Set<string>,
  subPhases: Phase[],
  chain: boolean,
): string {
  const inlinePhaseIds = flow.phases
    .filter((phase) => inlineSet.has(phase.id))
    .map((phase) => phase.id)
  const sections: string[] = [
    target.frontmatter({
      flowId: flow.id,
      description: s(
        flow.frontmatter.description,
        target.name,
        "flow.frontmatter.description",
      ),
      argumentHint: resolveArgumentHint(flow, target),
      model: flow.frontmatter.model,
      allowedTools: orchestratorAllowedTools(
        flow,
        target,
        inlinePhaseIds,
        subPhases.length > 0,
      ),
    }),
    `# ${s(flow.title, target.name, "flow.title")}`,
  ]

  pushIntro(sections, flow, target)
  if (usesPhaseReferences(flow, target) && subPhases.length > 0) {
    sections.push(
      "Load phase references only when routing reaches them. Read and follow the linked file in this same session, retaining the current mode, arguments, shared rules, and prior results. Resolve links relative to the file containing them. If an installed shim redirected you here, use this worktree skill's directory, not the shim directory or shell working directory. References are ordinary instruction files, not separately invocable skills.",
    )
  }
  if (Object.keys(flow.commands).length > 0) {
    sections.push(renderCommandsTable(flow, target))
  }
  pushInvariants(sections, flow)

  // Same top-level mode roadmap the monolith renderer emits, so a split /
  // split-chain command routes `$ARGUMENTS` from one table too. This is the
  // dispatching path, so the routing sentence points at each mode's sub-skill.
  const modesDispatch = renderModesDispatch(flow, target, true)
  if (modesDispatch !== null) {
    sections.push(modesDispatch)
  }

  let hasEntryDispatch = false
  if (chain) {
    const entryDispatch = renderEntryDispatch(flow, target, ctx, inlineSet)
    if (entryDispatch !== null) {
      sections.push(entryDispatch)
      hasEntryDispatch = true
    }
  }

  const subPhaseIds = new Set(subPhases.map((phase) => phase.id))
  for (const phase of flow.phases) {
    if (inlineSet.has(phase.id)) {
      const rendered = renderPhase(
        phase,
        target.name,
        ctx.allModes,
        ctx.modesPerStep,
        ctx.reachable,
        ctx.emitTemplate,
        true,
        chain
          ? orchestratorDispatchSuffix(
              flow,
              target,
              ctx,
              inlineSet,
              hasEntryDispatch,
            )
          : undefined,
        destinationRenderer(flow, target, inlineSet),
        0,
        // Split-chain orchestrators emit a `## Dispatch` block above the inline
        // phase; fold a single-mode gate under the first step heading so it can't
        // be misread as gating the dispatch. Non-chain/monolith keep the float.
        chain,
      )
      if (rendered.length > 0) {
        sections.push(rendered)
      }
    } else if (!chain && subPhaseIds.has(phase.id)) {
      sections.push(renderDispatch(flow, target, ctx, phase))
    }
  }

  pushAppendices(
    sections,
    flow,
    target,
    chain ? appendicesForUnit(flow, ctx, inlineSet, true) : flow.appendices,
  )
  return finalize(sections, flow, target, inlineSet)
}

/**
 * One dispatch section in the orchestrator pointing at a phase sub-skill. It
 * carries the phase's mode gate (so the agent only invokes the sub-skill in
 * the right modes) and tells the agent to invoke the sub-skill by name.
 */
function renderDispatch(
  flow: Flow,
  target: RenderTarget,
  ctx: RenderContext,
  phase: Phase,
): string {
  const title = s(phase.title, target.name, `phase[${phase.id}].title`)
  const stepKeys = phase.steps
    .map((step) => `${phase.id}/${step.id}`)
    .filter((key) => ctx.reachable.has(key))
  const { phaseGate } = precomputePhaseAndStepGates(
    stepKeys,
    ctx.modesPerStep,
    ctx.allModes,
  )
  const blocks = [`## ${title}`]
  if (phaseGate !== null) {
    blocks.push(phaseGate)
  }
  blocks.push(`Invoke the \`${flow.id}-${phase.id}\` skill, then return here.`)
  return blocks.join("\n\n")
}

/**
 * A phase sub-skill: its own frontmatter plus the phase body, rendered exactly
 * as the monolith would render that phase. Step numbering already resets per
 * phase, so the sub-skill reads as a standalone 1-indexed sequence.
 *
 * Under chain dispatch the sub-skill additionally carries: a mode preface
 * (multi-mode phases only - mode threading replaces "return here" as the
 * thing the agent must not drop), per-step "Next:" annotations for its
 * cross-unit edges, the appendices its steps reference, and the target's
 * skill-invocation tool in `allowed-tools` when it dispatches onward.
 */
function renderSubSkill(
  flow: Flow,
  target: RenderTarget,
  ctx: RenderContext,
  phase: Phase,
  chain: boolean,
): string {
  const phaseTitle = s(phase.title, target.name, `phase[${phase.id}].title`)
  const flowTitle = s(flow.title, target.name, "flow.title")
  const unitPhases = new Set([phase.id])
  const reachableSteps = phase.steps.filter((step) =>
    ctx.reachable.has(`${phase.id}/${step.id}`),
  )
  const hasDispatch =
    chain &&
    reachableSteps.some((step) =>
      computeDispatchEdges(
        step,
        `${phase.id}/${step.id}`,
        unitPhases,
        ctx,
      ).some((edge) => edge.kind === "dispatch"),
    )
  // No trailing period: namespaced frontmatters append a `. Usage…` /
  // `. Invoke with…` clause, which would otherwise read as a double period.
  // Chain sub-skills say "flow" rather than "orchestrator": the dispatcher may
  // be a sibling sub-skill.
  const invokedBy = chain
    ? `Invoked by the ${flow.id} flow; not run directly`
    : `Invoked by the ${flow.id} orchestrator; not run directly`
  const description = `${phaseTitle} phase of the ${flowTitle} flow. ${invokedBy}`
  const sections: string[] = []
  if (!usesPhaseReferences(flow, target)) {
    sections.push(
      target.subSkillFrontmatter({
        flowId: `${flow.id}-${phase.id}`,
        description,
        argumentHint: resolveArgumentHint(flow, target),
        model: flow.frontmatter.model,
        allowedTools: subSkillAllowedTools(flow, target, phase.id, hasDispatch),
      }),
    )
  }
  sections.push(`# ${flowTitle}: ${phaseTitle}`)
  if (chain) {
    const preface = renderModePreface(ctx, phase, reachableSteps)
    if (preface !== null) {
      sections.push(preface)
    }
  }
  // The H1 above already names the phase, so the body skips the `## {title}`
  // that the monolith renders (it would duplicate the heading).
  const rendered = renderPhase(
    phase,
    target.name,
    ctx.allModes,
    ctx.modesPerStep,
    ctx.reachable,
    ctx.emitTemplate,
    false,
    chain ? dispatchSuffixForUnit(flow, target, ctx, unitPhases) : undefined,
    destinationRenderer(flow, target, unitPhases),
  )
  if (rendered.length > 0) {
    sections.push(rendered)
  }
  if (chain) {
    pushAppendices(
      sections,
      flow,
      target,
      appendicesForUnit(flow, ctx, unitPhases, false),
    )
  }
  return finalize(sections, flow, target, unitPhases)
}

/**
 * Mode preface for a chain sub-skill. Emitted only when the phase is reachable
 * in more than one mode: the agent must know which mode it was dispatched
 * with, because the step gates and Next routing depend on it. Single-mode
 * phases (and single-mode flows) need nothing - the mode is implied by the
 * dispatch that got the agent here.
 */
function renderModePreface(
  ctx: RenderContext,
  phase: Phase,
  reachableSteps: Step[],
): string | null {
  const phaseModes = new Set<string>()
  for (const step of reachableSteps) {
    for (const mode of modesForStep(
      `${phase.id}/${step.id}`,
      ctx.modesPerStep,
      ctx.allModes,
    )) {
      phaseModes.add(mode)
    }
  }
  if (phaseModes.size < 2) {
    return null
  }
  const modeList = ctx.allModes
    .filter((m) => phaseModes.has(m))
    .map((m) => `\`${m}\``)
    .join(" or ")
  return `**Mode:** you were dispatched with a mode (${modeList}); which steps apply and where they route below depend on it.`
}

/**
 * `allowed-tools` for a sub-skill: the phase's own tools plus, under chain
 * dispatch, the target's skill-invocation tool when the phase routes onward
 * to another sub-skill. Mirrors `orchestratorAllowedTools`; when the phase
 * tools resolve to `undefined` (omit → full access) nothing is appended.
 */
function subSkillAllowedTools(
  flow: Flow,
  target: RenderTarget,
  phaseId: string,
  hasDispatch: boolean,
): string[] | undefined {
  const tools = resolveAllowedToolsForPhases(flow, target, [phaseId])
  if (tools === undefined || !hasDispatch) {
    return tools
  }
  if (target.subSkillTool && !tools.includes(target.subSkillTool)) {
    return [...tools, target.subSkillTool]
  }
  return tools
}

function resolveArgumentHint(
  flow: Flow,
  target: RenderTarget,
): string | undefined {
  const argumentHint = flow.frontmatter.argumentHint
  if (argumentHint === undefined) {
    return undefined
  }
  if (
    typeof argumentHint !== "object" ||
    !("deriveFromModes" in argumentHint)
  ) {
    return s(argumentHint, target.name, "frontmatter.argumentHint")
  }

  const modes = Object.keys(flow.entries).filter(
    (mode) => mode !== "default" || flow.defaultMode !== "default",
  )
  const open = flow.defaultMode !== undefined ? "[" : "<"
  const close = flow.defaultMode !== undefined ? "]" : ">"
  const modeHint = `${open}${modes.join("|")}${close}`
  if (argumentHint.suffix === undefined) {
    return modeHint
  }
  const suffix = s(
    argumentHint.suffix,
    target.name,
    "frontmatter.argumentHint.suffix",
  )
  return suffix.length > 0 ? `${modeHint} ${suffix}` : modeHint
}

function pushIntro(sections: string[], flow: Flow, target: RenderTarget): void {
  if (flow.intro === undefined) {
    return
  }
  const introStr = s(flow.intro, target.name, "flow.intro")
  if (introStr.length > 0) {
    sections.push(introStr)
  }
}

function pushInvariants(sections: string[], flow: Flow): void {
  if (flow.invariants.length > 0) {
    const items = flow.invariants.map((inv) => `- ${inv}`).join("\n")
    sections.push(`## Invariants\n\n${items}`)
  }
}

function pushAppendices(
  sections: string[],
  flow: Flow,
  target: RenderTarget,
  appendices: Flow["appendices"] = flow.appendices,
): void {
  for (const appendix of appendices) {
    const title = s(
      appendix.title,
      target.name,
      `appendix[${appendix.id}].title`,
    )
    const body = s(appendix.body, target.name, `appendix[${appendix.id}].body`)
    sections.push(`## ${title}\n\n${body}`)
  }
}

/**
 * `allowed-tools` for a split orchestrator: the inline phases' tools plus, when
 * the orchestrator dispatches to sub-skills, the target's skill-invocation tool
 * (Claude's `Skill`) so a scoped command can still hand off. When the inline
 * tools resolve to `undefined` (omit → full access) the orchestrator can
 * already invoke anything, so nothing is appended.
 */
function orchestratorAllowedTools(
  flow: Flow,
  target: RenderTarget,
  inlinePhaseIds: string[],
  hasSubSkills: boolean,
): string[] | undefined {
  const tools = resolveAllowedToolsForPhases(flow, target, inlinePhaseIds)
  if (tools === undefined) {
    return undefined
  }
  if (
    hasSubSkills &&
    target.subSkillTool &&
    !tools.includes(target.subSkillTool)
  ) {
    return [...tools, target.subSkillTool]
  }
  return tools
}

/**
 * Auto-derive `allowed-tools` from the union of the named phases' tool calls,
 * in registry order. Returns `undefined` (omit the field) when the flow
 * declares no tools and no manual override, or when the selected phases call
 * no tools - an empty `allowed-tools: []` would needlessly handcuff a pure
 * dispatcher orchestrator.
 */
function resolveAllowedToolsForPhases(
  flow: Flow,
  target: RenderTarget,
  phaseIds: string[],
): string[] | undefined {
  if (Object.keys(flow.tools).length === 0) {
    return flow.frontmatter.allowedTools
  }
  const ids = collectPhaseToolIds(flow, target, phaseIds).filter((id) =>
    toolAvailableOnTarget(flow.tools[id], target.name),
  )
  if (ids.length === 0) {
    return undefined
  }
  return ids.map((id) => fullToolName(flow, id, target))
}

const HAS_COMMAND_RE = new RegExp(COMMAND_PLACEHOLDER_RE.source)

/**
 * Tool ids called within the named phases, in flow registry order.
 *
 * Beyond explicit `{{tool:}}` references and `step.toolCalls`, a phase also uses
 * a tool implicitly whenever it invokes a command or emits an activity
 * line: `{{command:X}}`, `step.commandCalls`, and the `emit` template all render
 * to a command the agent runs through the runner tool (`commandRunnerTool`,
 * usually `Bash`). Those aren't `{{tool:}}` references, so without this the
 * derived `allowed-tools` would omit the runner for a phase whose only use is a
 * command or the emit. Harmless in a monolith (the union usually has it), but
 * under split-chain that phase becomes
 * its own sub-skill and the missing tool would deny the command at runtime.
 */
function collectPhaseToolIds(
  flow: Flow,
  target: RenderTarget,
  phaseIds: string[],
): string[] {
  const wanted = new Set(phaseIds)
  const called = new Set<string>()
  // The builtin runner tool id (if the flow registers one), which every
  // command / emit invocation resolves to.
  const runnerId = Object.entries(flow.tools).find(
    ([, tool]) =>
      tool.kind === "builtin" &&
      resolvePerTarget(tool.name, target.name) === target.commandRunnerTool,
  )?.[0]
  const emitTemplate =
    flow.emitTemplate !== undefined
      ? s(flow.emitTemplate, target.name, "flow.emitTemplate")
      : undefined
  const emitUsesCommand =
    emitTemplate !== undefined && HAS_COMMAND_RE.test(emitTemplate)
  const scan = (text: string | undefined): void => {
    if (text === undefined) {
      return
    }
    for (const match of text.matchAll(TOOL_PLACEHOLDER_RE)) {
      called.add(match[1] as string)
    }
    if (runnerId !== undefined && HAS_COMMAND_RE.test(text)) {
      called.add(runnerId)
    }
  }
  for (const phase of flow.phases) {
    if (!wanted.has(phase.id)) {
      continue
    }
    if (phase.intro !== undefined) {
      scan(s(phase.intro, target.name, `phase[${phase.id}].intro`))
    }
    for (const step of phase.steps) {
      for (const id of step.toolCalls ?? []) {
        called.add(id)
      }
      if (
        runnerId !== undefined &&
        ((step.commandCalls?.length ?? 0) > 0 ||
          (step.emit !== undefined && emitUsesCommand))
      ) {
        called.add(runnerId)
      }
      scan(s(step.body, target.name, `step[${step.id}].body`))
    }
  }
  return Object.keys(flow.tools).filter((id) => called.has(id))
}

export function renderMarkdown(flow: Flow, target: RenderTarget): string {
  const sections: string[] = []

  const description = s(
    flow.frontmatter.description,
    target.name,
    `flow.frontmatter.description`,
  )
  const argumentHint = resolveArgumentHint(flow, target)
  sections.push(
    target.frontmatter({
      flowId: flow.id,
      description,
      argumentHint,
      model: flow.frontmatter.model,
      allowedTools: resolveAllowedTools(flow, target),
    }),
  )

  sections.push(`# ${s(flow.title, target.name, "flow.title")}`)

  if (flow.intro !== undefined) {
    const introStr = s(flow.intro, target.name, "flow.intro")
    if (introStr.length > 0) {
      sections.push(introStr)
    }
  }

  if (Object.keys(flow.commands).length > 0) {
    sections.push(renderCommandsTable(flow, target))
  }

  // Flow-wide invariants - rules that apply throughout, rendered once near
  // the top so the agent reads them before working through the phases. Each
  // invariant is a one-line bullet under `## Invariants`. Standard
  // placeholders (`{{tool:…}}`, `{{cmd}}`, Mustache sections) work because
  // the substitution pipeline runs over the joined output below.
  if (flow.invariants.length > 0) {
    const items = flow.invariants.map((inv) => `- ${inv}`).join("\n")
    sections.push(`## Invariants\n\n${items}`)
  }

  // Multi-mode monoliths get an auto-generated dispatch table so the agent maps
  // `$ARGUMENTS` to a mode from one place, instead of each flow hand-authoring
  // its own overview. Single-mode flows emit nothing here (output unchanged).
  const modesDispatch = renderModesDispatch(flow, target, false)
  if (modesDispatch !== null) {
    sections.push(modesDispatch)
  }

  const allModes = Object.keys(flow.entries)
  const modesPerStep = computeModesPerStep(flow, target.name)
  const reachable = computeReachableSteps(flow, target.name)
  const emitTemplate =
    flow.emitTemplate !== undefined
      ? s(flow.emitTemplate, target.name, "flow.emitTemplate")
      : undefined
  // When the flow opts into continuous numbering (sequential-phase monoliths),
  // each phase's headers start one past the numbered steps rendered so far, so
  // a multi-phase file reads ## 1 … ## N instead of restarting at ## 1. per
  // phase (which would emit duplicate header numbers). Off by default: phases
  // that are mutually-exclusive alternatives keep per-phase restart.
  const continuous = flow.compile.continuousStepNumbers === true
  let stepNumberOffset = 0
  for (const phase of flow.phases) {
    const rendered = renderPhase(
      phase,
      target.name,
      allModes,
      modesPerStep,
      reachable,
      emitTemplate,
      true,
      undefined,
      destinationRenderer(flow, target),
      stepNumberOffset,
    )
    if (continuous) {
      stepNumberOffset += countNumberedSteps(phase, reachable)
    }
    // Skip phases with no reachable steps - pushing an empty string here would
    // create a double `\n\n` separator (triple newline) between adjacent
    // visible sections, which shows up as an extra blank line in the output.
    if (rendered.length > 0) {
      sections.push(rendered)
    }
  }

  if (flow.appendices.length > 0) {
    for (const appendix of flow.appendices) {
      const title = s(
        appendix.title,
        target.name,
        `appendix[${appendix.id}].title`,
      )
      const body = s(
        appendix.body,
        target.name,
        `appendix[${appendix.id}].body`,
      )
      sections.push(`## ${title}\n\n${body}`)
    }
  }

  return finalize(sections, flow, target)
}

/**
 * Join rendered sections and run the substitution pipeline. Shared by the
 * monolith renderer and the split orchestrator / sub-skill renderers so every
 * generated file resolves placeholders identically.
 *
 * Order matters: strip non-matching Mustache sections FIRST. Otherwise
 * placeholders inside (e.g.) `{{#codex}}{{step:codex-only-step}}{{/codex}}`
 * get resolved against the wrong target's reachability set and throw.
 *
 * `unitPhases` (split modes only) names the phases compiled into this file;
 * `{{step:...}}` refs outside that set throw, because step numbers are
 * file-local and a bare number pointing into another skill file is silently
 * meaningless to the agent reading it.
 */
function finalize(
  sections: string[],
  flow: Flow,
  target: RenderTarget,
  unitPhases?: Set<string>,
): string {
  const joined = sections.join("\n\n")
  const afterSections = applyModeSections(
    applyMustacheSections(joined, target),
    flow,
    target.name,
    unitPhases,
  )
  const withFlowData = applyFlowPlaceholders(
    afterSections,
    flow,
    target,
    unitPhases,
  )
  const substituted = applyTokens(withFlowData, target, flow)
  return ensureTrailingNewline(substituted)
}

/**
 * Substitute flow-level data placeholders.
 *
 * - `{{step:phase-id/step-id}}` - renders the step's number for the current
 *   target (preamble steps render as "0"). Catches stale step references
 *   when the flow's steps are reordered or split. File-local: throws across a
 *   split-unit boundary (numbers aren't visible in another skill file).
 * - `{{step-ref:phase-id/step-id}}` - renders the step's `refName` (or `title`),
 *   a stable name for CROSS-phase prose references. Existence is validated, but
 *   unlike `{{step:...}}` it carries no number, so it works across phases and
 *   split-unit files without a boundary check.
 * - `{{skill-ref:phase-id}}` - a mode-aware noun phrase for where a phase's
 *   content lives: "the `<flow>-<phase>` skill" under split/split-chain (phase
 *   outside the current unit), "the *<Phase Title>* section" under monolith or
 *   in-unit. For routing prose that names a destination phase.
 * - `{{dispatch-ref:phase-id}}` - like `{{skill-ref}}`, but for prose that
 *   *dispatches* to the phase (gate overrides bypassing the `**Next:**` block):
 *   under split/split-chain it also carries "with the current mode, forwarding
 *   `<argsToken>` minus the leading mode keyword" - the same mode + args the
 *   `**Next:**` and `## Dispatch` blocks pass - so the mode-gated sub-skill
 *   still receives both.
 * - `{{tool:id}}` - backtick-wrapped per-target tool name from `flow.tools`
 *   (with the target's `mcpPrefix` for MCP tools)
 * - `{{table:name:F1,F2,...}}` - markdown table of `flow.tables[name]`: the
 *   key column plus the named fields
 * - `{{list:name:FIELD}}` - bullets of `label: value` for one field
 *
 * Output still contains target tokens (`{{cmd}}`, `{{editor}}`); those are
 * resolved by `applyTemplate` after this pass.
 */
function applyFlowPlaceholders(
  text: string,
  flow: Flow,
  target: RenderTarget,
  unitPhases?: Set<string>,
): string {
  let result = text

  // `{{step-ref:phase-id/step-id}}` — renders the step's `refName` (or `title`
  // if unset), a stable name for cross-phase prose references. Unlike
  // `{{step:...}}` it does NOT render a file-local number, so it needs no
  // split-unit boundary check: a name is meaningful across phases and across
  // sub-skill files. Existence is still validated (catches renamed/removed
  // steps at build time). Runs before `{{step:...}}`; the two patterns are
  // distinct (`step-` vs `step:`) so there is no overlap.
  result = result.replace(
    /\{\{step-ref:([a-z0-9-]+\/[a-z0-9-]+)\}\}/g,
    (_match, ref: string) => {
      const [phaseId, stepId] = ref.split("/")
      const step = flow.phases
        .find((p) => p.id === phaseId)
        ?.steps.find((st) => st.id === stepId)
      if (step === undefined) {
        throw new Error(
          `Step reference {{step-ref:${ref}}} not found in flow "${flow.id}" for target "${target.name}"`,
        )
      }
      const name = step.refName ?? step.title
      return s(name, target.name, `step[${ref}].refName`)
    },
  )

  // `{{skill-ref:phase-id}}` — a mode-aware noun phrase for where a phase's
  // content lives, for routing prose (e.g. a gate override that jumps straight
  // to a terminal phase). Under split / split-chain a phase outside the current
  // unit compiles to its own sub-skill, so this renders "the `<flow>-<phase>`
  // skill" (the same reference the dispatch blocks use). In a monolith, or when
  // the phase is in the current unit, the content is a section in this file, so
  // it renders "the *<Phase Title>* section". This keeps routing prose correct
  // in every compile mode without hardcoding "skill" (wrong under monolith) or
  // "phase" (unroutable under split-chain, where the phase is a hidden skill the
  // step's `**Next:**` block may not name).
  result = result.replace(
    /\{\{skill-ref:([a-z0-9-]+)\}\}/g,
    (_match, phaseId: string) => {
      const phase = flow.phases.find((p) => p.id === phaseId)
      if (phase === undefined) {
        throw new Error(
          `Skill reference {{skill-ref:${phaseId}}} not found in flow "${flow.id}" for target "${target.name}"`,
        )
      }
      const sameUnit = unitPhases === undefined || unitPhases.has(phaseId)
      if (sameUnit) {
        const title = s(phase.title, target.name, `phase[${phaseId}].title`)
        return `the *${title}* section`
      }
      return phaseDestination(flow, target, phaseId, unitPhases)
    },
  )

  // `{{dispatch-ref:phase-id}}` — like `{{skill-ref}}`, but for routing prose
  // that *dispatches* to the phase rather than merely naming it (gate overrides
  // that bypass the auto-generated `**Next:**` block, which is the only place
  // that otherwise passes the mode + forwards the argument token). Under split /
  // split-chain the target is a sub-skill that gates its own behavior on the
  // mode it was dispatched with, so this renders "the `<flow>-<phase>` skill
  // with the current mode, forwarding `<argsToken>` minus the leading mode
  // keyword" — carrying both the mode and the exact args the `**Next:**` /
  // `## Dispatch` blocks would forward. In a monolith (or same unit)
  // the content is inline in this file with the mode already in scope, so it
  // degrades to the same "the *<Phase Title>* section" as `{{skill-ref}}`.
  result = result.replace(
    /\{\{dispatch-ref:([a-z0-9-]+)\}\}/g,
    (_match, phaseId: string) => {
      const phase = flow.phases.find((p) => p.id === phaseId)
      if (phase === undefined) {
        throw new Error(
          `Dispatch reference {{dispatch-ref:${phaseId}}} not found in flow "${flow.id}" for target "${target.name}"`,
        )
      }
      const sameUnit = unitPhases === undefined || unitPhases.has(phaseId)
      if (sameUnit) {
        const title = s(phase.title, target.name, `phase[${phaseId}].title`)
        return `the *${title}* section`
      }
      const destination = phaseDestination(flow, target, phaseId, unitPhases)
      return `${destination} with the current mode, forwarding \`${target.argsToken}\` minus the leading mode keyword (if the user typed one)`
    },
  )

  // Continuous numbering (matching the continuous header numbering) applies
  // only to monolith files (no `unitPhases`) whose flow opted in. Split files
  // keep per-phase numbering because each phase compiles to its own file, and
  // monoliths that didn't opt in keep per-phase restart for mode-gated phases.
  const stepNumbers = computeStepNumbers(
    flow,
    target.name,
    unitPhases === undefined && flow.compile.continuousStepNumbers === true,
  )
  result = result.replace(
    /\{\{step:([a-z0-9-]+\/[a-z0-9-]+)\}\}/g,
    (_match, ref: string) => {
      const num = stepNumbers.get(ref)
      if (num === undefined) {
        throw new Error(
          `Step reference {{step:${ref}}} not found in flow "${flow.id}" for target "${target.name}"`,
        )
      }
      // Step numbers are file-local. Under split compile modes a ref into a
      // phase outside this file would render a bare number that points into
      // a different skill file - meaningless to the agent reading it. Reword
      // the prose to name the sub-skill (or the phase) instead.
      const refPhase = ref.split("/")[0] as string
      if (unitPhases !== undefined && !unitPhases.has(refPhase)) {
        throw new Error(
          `Step reference {{step:${ref}}} crosses a split-unit boundary in flow "${flow.id}" (target "${target.name}"): phase "${refPhase}" compiles to its own file, so its step numbers are not visible here. Reference the \`${flow.id}-${refPhase}\` skill by name instead.`,
        )
      }
      return String(num)
    },
  )

  result = result.replace(
    /\{\{tool:([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g,
    (_match, toolId: string) => `\`${fullToolName(flow, toolId, target)}\``,
  )

  result = result.replace(
    /\{\{command:([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g,
    (_match, commandId: string) => {
      const def = flow.commands[commandId]
      if (def === undefined) {
        throw new Error(`Command "${commandId}" not declared in flow.commands`)
      }
      return target.invokeCommand(def)
    },
  )

  // `{{table:...}}` / `{{list:...}}` expand to multi-line blocks AFTER list
  // bodies have been indented (`indentBody` runs at phase render time, this
  // substitution runs in `finalize`), so only the placeholder's own line
  // carries the list indent. Re-apply that indent to the block's continuation
  // lines, otherwise rows after the first dedent out of the surrounding list
  // item and break the markdown nesting.
  result = result.replace(
    /\{\{(table|list):([a-zA-Z][a-zA-Z0-9_-]*):([a-zA-Z0-9_,-]+)\}\}/g,
    (
      _match,
      kind: string,
      tableName: string,
      columnsRaw: string,
      offset: number,
    ) => {
      const block = renderTableBlock(
        flow,
        kind as "table" | "list",
        tableName,
        columnsRaw.split(","),
      )
      return inheritLineIndent(result, offset, block)
    },
  )

  return result
}

/**
 * Map of `phase-id/step-id` → step number for the given target. Mirrors the
 * numbering logic in `renderPhaseAsHeaders` / `renderPhaseAsList`: preamble
 * steps render as 0, everything else 1-indexed among visible steps.
 *
 * `continuous` (monolith files) runs one counter across every phase so numbers
 * match the continuous header numbering; the default per-phase counter matches
 * split files, where each phase compiles to its own file and restarts at 1.
 */
function computeStepNumbers(
  flow: Flow,
  target: TargetName,
  continuous = false,
): Map<string, number> {
  const result = new Map<string, number>()
  const reachable = computeReachableSteps(flow, target)
  let counter = 1
  for (const phase of flow.phases) {
    if (!continuous) {
      counter = 1
    }
    for (const step of phase.steps) {
      if (!reachable.has(`${phase.id}/${step.id}`)) {
        continue
      }
      const num = step.preamble === true ? 0 : counter
      if (step.preamble !== true) {
        counter += 1
      }
      result.set(`${phase.id}/${step.id}`, num)
    }
  }
  return result
}

/**
 * Auto-derive `allowed-tools` from the union of every step's `toolCalls`,
 * using registry order. When the flow declares no tools the explicit
 * `frontmatter.allowedTools` is used as-is.
 */
function resolveAllowedTools(
  flow: Flow,
  target: RenderTarget,
): string[] | undefined {
  if (Object.keys(flow.tools).length === 0) {
    return flow.frontmatter.allowedTools
  }
  const calledIds = collectCalledToolIds(flow).filter((id) =>
    toolAvailableOnTarget(flow.tools[id], target.name),
  )
  return calledIds.map((id) => fullToolName(flow, id, target))
}

/**
 * Whether a tool is available on a target. A tool with no `targets` allowlist
 * is available everywhere; otherwise only on the listed agents.
 */
function toolAvailableOnTarget(
  def: { targets?: readonly TargetName[] },
  targetName: TargetName,
): boolean {
  return def.targets === undefined || def.targets.includes(targetName)
}

function fullToolName(
  flow: Flow,
  toolId: string,
  target: RenderTarget,
): string {
  const def = flow.tools[toolId]
  if (def === undefined) {
    throw new Error(`Tool "${toolId}" not declared in flow.tools`)
  }
  if (!toolAvailableOnTarget(def, target.name)) {
    throw new Error(
      `Tool "${toolId}" is not available on target "${target.name}" (its \`targets\` allowlist is [${def.targets?.join(", ")}]). A {{tool:${toolId}}} reference reached this target's prose - gate it behind a {{#${def.targets?.[0]}}} section so it is stripped for other agents.`,
    )
  }
  const name = resolvePerTarget(def.name, target.name)
  if (name === undefined) {
    throw new Error(
      `Tool "${toolId}" has no name for target "${target.name}" (and no default)`,
    )
  }
  return def.kind === "mcp" ? `${target.mcpPrefix}${name}` : name
}

/**
 * Auto-generated "Modes" dispatch block for a multi-mode monolith flow. Emits a
 * table of every mode (in `entries` order) with its trigger token and a
 * one-line description, plus an explicit `$ARGUMENTS` routing instruction, so
 * the agent maps the argument to a mode without hand-authored routing prose.
 *
 * A mode's description comes from `flow.modeHints[mode]`; when absent it falls
 * back to the title of the phase the mode enters. The `defaultMode` renders its
 * trigger as "(no argument)"; every other mode's trigger is its own name (dev
 * flows name each entry after the arg token that selects it).
 *
 * Opt-in: the block is emitted ONLY when the flow declares `modeHints`. This is
 * the gate that keeps the block off flows that don't want it (e.g. the
 * user-facing setup/update/assistant flows, which route via their own
 * `## Dispatch` section) and guarantees it never renders with junk phase-title
 * fallbacks for every row. A flow opts in by adding at least one `modeHints`
 * entry; modes it omits still fall back to their phase title.
 *
 * Returns null for single-mode flows and for flows that haven't opted in,
 * leaving their output byte-identical to before.
 */
function renderModesDispatch(
  flow: Flow,
  target: RenderTarget,
  dispatches: boolean,
): string | null {
  const modes = Object.keys(flow.entries)
  if (modes.length <= 1 || Object.keys(flow.modeHints).length === 0) {
    return null
  }

  const phaseTitle = (mode: string): string => {
    const entryRef = flow.entries[mode]
    if (entryRef === undefined) {
      return mode
    }
    const entry = resolvePerTarget(entryRef, target.name)
    if (entry === undefined) {
      return mode
    }
    const phaseId = entry.split("/")[0]
    const phase = flow.phases.find((p) => p.id === phaseId)
    return phase !== undefined
      ? s(phase.title, target.name, `phase[${phaseId}].title`)
      : mode
  }

  const rows = modes.map((mode) => {
    const hint = flow.modeHints[mode]
    const description =
      hint !== undefined
        ? s(hint, target.name, `modeHints.${mode}`)
        : phaseTitle(mode)
    // The synthetic `default` mode is the no-argument landing (not a token the
    // user types). A named default mode (e.g. `up`) is both a real trigger token
    // AND what runs with no argument, so show both.
    const trigger =
      mode === flow.defaultMode
        ? mode === "default"
          ? "(no argument)"
          : `\`${mode}\` (default)`
        : `\`${mode}\``
    return `| \`${mode}\` | ${trigger} | ${description} |`
  })

  // Monolith flows render every mode's steps inline, so the agent runs the
  // matching section in this file. Split / split-chain flows dispatch each mode
  // to a sub-skill (see the phase dispatch / `## Dispatch` routing below), so
  // "section below" would be wrong; point at the mode's path instead.
  const follow = dispatches
    ? "Follow only the selected mode's path below."
    : "Run only that mode's section below and skip the others."
  // Route on an exact mode token first. The fallback is flow-shape aware: only
  // an explicit mode name selects a mode, because many flows take content as the
  // first argument (a scope, a PR id, a provider, a bare function key) that
  // belongs to the default mode, not a mode selector. When a flow documents its
  // own argument routing (setup/assistant infer the mode from natural language
  // and aliases), defer to that prose instead of claiming non-mode input always
  // lands on the default; otherwise fall to the default and let it consume the
  // arguments (the correct behavior for keyword-dispatch and content-first dev
  // flows, which document no routing of their own).
  const args = `\`${target.argsToken}\``
  const routing =
    flow.defaultMode !== undefined
      ? `Read ${args} first. If its first token is exactly one of the mode names below, run that mode. Otherwise, when this skill documents how to route the remaining arguments (see its intro), follow that; if it doesn't, run \`${flow.defaultMode}\` and treat ${args} as its input. ${follow}`
      : `Read ${args} first. If its first token is exactly one of the mode names below, run that mode; otherwise route it using this skill's argument-routing guidance. ${follow}`

  return [
    "## Modes",
    "",
    routing,
    "",
    "| Mode | Trigger | What it does |",
    "|------|---------|--------------|",
    ...rows,
  ].join("\n")
}

function renderCommandsTable(flow: Flow, target: RenderTarget): string {
  const rows: string[] = []
  for (const def of Object.values(flow.commands)) {
    const sig = def.args !== undefined ? `${def.file} ${def.args}` : def.file
    rows.push(`| \`${sig}\` | ${def.description} |`)
  }
  return [
    target.commandsTableIntro,
    "",
    "| Command | Description |",
    "|---------|-------------|",
    ...rows,
  ].join("\n")
}

function renderTableBlock(
  flow: Flow,
  kind: "table" | "list",
  tableName: string,
  columns: string[],
): string {
  const table = flow.tables[tableName]
  if (table === undefined) {
    throw new Error(`Table "${tableName}" not declared in flow.tables`)
  }
  if (kind === "list") {
    if (columns.length !== 1) {
      throw new Error(
        `{{list:${tableName}:…}} takes exactly one column, got ${columns.join(",")}`,
      )
    }
    const column = columns[0] as string
    return table.rows
      .filter((row) => row.cells[column] !== undefined)
      .map((row) => `- ${row.label ?? row.key}: ${row.cells[column]}`)
      .join("\n")
  }
  const headers = [
    table.keyHeader,
    ...columns.map((c) => table.columns[c] ?? titleCase(c)),
  ]
  const lines = [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
  ]
  for (const row of table.rows) {
    const cells = columns.map((col) => row.cells[col])
    if (cells.every((c) => c !== undefined)) {
      lines.push(`| ${row.key} | ${cells.join(" | ")} |`)
    }
  }
  return lines.join("\n")
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * When a placeholder leads its (possibly indented) line, prefix the
 * expansion's continuation lines with that indent so a multi-line value stays
 * inside the surrounding list item. Mid-sentence placeholders keep the value
 * as-is.
 */
function inheritLineIndent(
  text: string,
  offset: number,
  value: string,
): string {
  if (!value.includes("\n")) {
    return value
  }
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1
  const before = text.slice(lineStart, offset)
  if (!/^[ \t]*$/.test(before)) {
    return value
  }
  return value
    .split("\n")
    .map((line, i) => (i === 0 || line.length === 0 ? line : before + line))
    .join("\n")
}

/** Callback computing a chain-dispatch "Next:" block for a step (or null). */
type DispatchSuffixFor = (step: Step, stepKey: string) => string | null

/**
 * Renders a branch's `next` as human-readable destination prose, relative to
 * the phase the branch step lives in (step numbers restart per phase).
 */
type DestinationFor = (next: BranchNext, sourcePhaseId: string) => string

/** Structural shape of a step/branch `next` (the schema's `Next` union). */
type BranchNext = string | null | { byMode: Record<string, string | null> }

/**
 * Build the destination renderer for one compiled file. Destinations appear
 * on `{{branches}}` option lines and `{{whens}}` routing lines so the agent
 * sees where each choice goes instead of inferring the wiring from prose:
 *
 *   - same-phase ref  → "step {{step:phase/step}}" (number resolved later)
 *   - other phase,
 *     same file       → "step N of the {Phase Title} phase" (bare numbers
 *     are ambiguous across phases; numbering restarts per phase)
 *   - cross-unit ref  → "the `flow-phase` skill" (split modes; bare step
 *     numbers are file-local, see the {{step:...}} boundary check)
 *   - null            → "stop"
 *   - byMode          → per-destination groups: "step 3 (mode `a`); stop
 *     (mode `b`)". When the largest group spans 2+ modes it renders last as
 *     "otherwise ..." instead of enumerating every mode.
 */
function destinationRenderer(
  flow: Flow,
  target: RenderTarget,
  unitPhases?: Set<string>,
): DestinationFor {
  const one = (ref: string | null, sourcePhaseId: string): string => {
    if (ref === null) {
      return "stop"
    }
    const phaseId = ref.split("/")[0] as string
    if (unitPhases !== undefined && !unitPhases.has(phaseId)) {
      if (usesPhaseReferences(flow, target)) {
        return phaseDestination(flow, target, phaseId, unitPhases)
      }
      return `the \`${flow.id}-${phaseId}\` skill`
    }
    if (phaseId === sourcePhaseId) {
      return `step {{step:${ref}}}`
    }
    const phase = flow.phases.find((p) => p.id === phaseId)
    const title =
      phase !== undefined
        ? s(phase.title, target.name, `phase[${phaseId}].title`)
        : phaseId
    return `step {{step:${ref}}} of the ${title} phase`
  }
  return (next, sourcePhaseId) => {
    if (next === null || typeof next === "string") {
      return one(next, sourcePhaseId)
    }
    const groups = new Map<string, string[]>()
    for (const [mode, ref] of Object.entries(next.byMode)) {
      const dest = one(ref, sourcePhaseId)
      const modes = groups.get(dest) ?? []
      modes.push(mode)
      groups.set(dest, modes)
    }
    const entries = [...groups.entries()]
    if (entries.length === 1) {
      // Every mode agrees: no mode prose needed.
      return (entries[0] as [string, string[]])[0]
    }
    const describe = ([dest, modes]: [string, string[]]): string =>
      `${dest} (mode ${modes.map((m) => `\`${m}\``).join(" or ")})`
    const largest = entries.reduce((a, b) =>
      b[1].length > a[1].length ? b : a,
    )
    if (largest[1].length < 2) {
      return entries.map(describe).join("; ")
    }
    // Enumerate the smaller groups; the catch-all renders as "otherwise".
    const rest = entries.filter((e) => e !== largest)
    return [...rest.map(describe), `otherwise ${largest[0]}`].join("; ")
  }
}

function renderPhase(
  phase: Phase,
  target: TargetName,
  allModes: string[],
  modesPerStep: Map<string, Set<string>>,
  reachable: Set<string>,
  emitTemplate: string | undefined,
  // List-style phases lead with a `## {title}` heading. Sub-skills pass false
  // because they already carry the phase name in their own H1. Headers-style
  // phases never emit the title, so the flag is a no-op there.
  includePhaseTitle = true,
  // Chain dispatch only: appends a "Next:" block to steps with cross-unit
  // edges. Undefined for monolith and call-and-return split.
  dispatchSuffixFor?: DispatchSuffixFor,
  // Appends "→ destination" to branch option/when lines. All renderers pass
  // one; optional only so the parameter can trail the older ones.
  destinationFor?: DestinationFor,
  // First step number for this phase minus one. Zero (per-phase 1-indexing) for
  // every split caller and sub-skill. The monolith renderer passes the running
  // count of numbered steps in earlier phases so a multi-phase monolith numbers
  // its headers continuously (## 1 … ## N across phases) instead of restarting
  // at ## 1. in each phase, which would emit duplicate header numbers in one
  // file.
  stepNumberOffset = 0,
  // Forwarded to renderPhaseAsHeaders: fold a single-mode phase gate under the
  // first step heading instead of floating it. Set only by the split-chain
  // orchestrator inline call (see its comment there).
  foldSingleModeGate = false,
): string {
  const visibleSteps = phase.steps
    .filter((step) => reachable.has(`${phase.id}/${step.id}`))
    .map((step) => ({
      step,
      stepKey: `${phase.id}/${step.id}`,
    }))
  if (visibleSteps.length === 0) {
    return ""
  }

  if (phase.stepStyle === "headers") {
    return renderPhaseAsHeaders(
      phase,
      visibleSteps,
      allModes,
      modesPerStep,
      target,
      emitTemplate,
      dispatchSuffixFor,
      destinationFor,
      stepNumberOffset,
      foldSingleModeGate,
    )
  }
  return renderPhaseAsList(
    phase,
    visibleSteps,
    allModes,
    modesPerStep,
    target,
    emitTemplate,
    includePhaseTitle,
    dispatchSuffixFor,
    destinationFor,
    stepNumberOffset,
  )
}

/**
 * Count of numbered (reachable, non-preamble) steps in a phase for one target.
 * The monolith renderer sums these across earlier phases to seed continuous
 * header numbering; preamble steps render as 0 and never advance the counter,
 * so they're excluded here to match.
 */
function countNumberedSteps(phase: Phase, reachable: Set<string>): number {
  return phase.steps.filter(
    (step) => reachable.has(`${phase.id}/${step.id}`) && step.preamble !== true,
  ).length
}

function modesForStep(
  stepKey: string,
  modesPerStep: Map<string, Set<string>>,
  allModes: string[],
): Set<string> {
  return modesPerStep.get(stepKey) ?? new Set(allModes)
}

/**
 * Format a positive mode-gate sentence: "Run only when mode is `X`." for one
 * mode, "Run only when mode is `X` or `Y`." for two, "Run only when mode is
 * `X`, `Y` or `Z`." for three or more.
 */
function formatPositiveGate(inModes: string[]): string {
  const phrases = inModes.map((m) => `\`${m}\``)
  const list =
    phrases.length === 1
      ? phrases[0]
      : `${phrases.slice(0, -1).join(", ")} or ${phrases[phrases.length - 1]}`
  return `**Run only when mode is ${list}.**`
}

/**
 * Build mode-gating prose for a phase, in the positive form: "Run only when
 * mode is `X` [or `Y`]". Two output channels:
 *
 *   - `phaseGate`: a single line emitted just under the phase heading when
 *     every visible step in the phase is reachable in the same proper subset
 *     of modes. One line gates the whole phase; no per-step prose needed.
 *
 *   - `perStepGates`: per-step gates emitted in the step body when the
 *     phase has mixed reachability (different steps reachable in different
 *     mode subsets - e.g. step 2 runs in modes `a`/`b` but step 3 runs in
 *     `a`/`c`). Each affected step gets its own positive
 *     gate; gates do not cascade or inherit.
 *
 * Steps reachable in every declared mode get no gate. Phases where every
 * visible step is reachable in every mode also get no `phaseGate`.
 *
 * The positive form is unambiguous on scope (it states when the step runs,
 * full stop) and is usually shorter than the negative "Skip if X" form when
 * there are more excluded modes than included modes.
 */
function precomputePhaseAndStepGates(
  stepKeys: string[],
  modesPerStep: Map<string, Set<string>>,
  allModes: string[],
): { phaseGate: string | null; perStepGates: Map<string, string> } {
  if (stepKeys.length === 0) {
    return { phaseGate: null, perStepGates: new Map() }
  }

  const stepModeSets = stepKeys.map((key) =>
    modesForStep(key, modesPerStep, allModes),
  )
  const allModesCount = allModes.length
  const firstSet = stepModeSets[0]
  const uniform = stepModeSets.every(
    (s) =>
      s.size === firstSet.size && [...s].every((mode) => firstSet.has(mode)),
  )

  if (uniform) {
    if (firstSet.size === allModesCount) {
      // Phase reachable in every mode: no gate at all.
      return { phaseGate: null, perStepGates: new Map() }
    }
    const inModes = allModes.filter((m) => firstSet.has(m))
    return {
      phaseGate: formatPositiveGate(inModes),
      perStepGates: new Map(),
    }
  }

  // Mixed reachability: each affected step gets its own positive gate.
  const perStepGates = new Map<string, string>()
  for (let i = 0; i < stepKeys.length; i++) {
    const set = stepModeSets[i]
    if (set.size === allModesCount) {
      continue
    }
    const inModes = allModes.filter((m) => set.has(m))
    perStepGates.set(stepKeys[i], formatPositiveGate(inModes))
  }
  return { phaseGate: null, perStepGates }
}

function renderEmit(step: Step, template: string | undefined): string | null {
  if (step.emit === undefined || template === undefined) {
    return null
  }
  let displayName: string
  let action: string
  if (typeof step.emit === "string") {
    displayName = step.emit
    action = "started"
  } else {
    displayName = step.emit.displayName
    action = step.emit.action
  }
  return template
    .replace(/\{action\}/g, action)
    .replace(/\{displayName\}/g, displayName)
}

function bodyWithModeGate(
  step: Step,
  stepKey: string,
  perStepGates: Map<string, string>,
  target: TargetName,
  emitTemplate: string | undefined,
  dispatchSuffixFor?: DispatchSuffixFor,
  destinationFor?: DestinationFor,
): string {
  const withBranches = expandBranchesPlaceholders(
    step,
    stepKey.split("/")[0] as string,
    target,
    destinationFor,
  )
  const parts: string[] = []
  const gate = perStepGates.get(stepKey)
  if (gate !== undefined) {
    parts.push(gate)
  }
  const emitted = renderEmit(step, emitTemplate)
  if (emitted !== null) {
    parts.push(emitted)
  }
  parts.push(withBranches)
  const dispatchSuffix = dispatchSuffixFor?.(step, stepKey)
  if (dispatchSuffix !== undefined && dispatchSuffix !== null) {
    parts.push(dispatchSuffix)
  }
  return parts.join("\n\n")
}

/**
 * Replace branch-related placeholders in a branch step's body:
 *
 * - `{{branches}}` / `{{branches:prompt-name}}` - formatted user-choice
 *   option block. Only branches with an `option` field are rendered.
 * - `{{whens}}` - formatted runtime-branch routing block. Only branches
 *   with a `when` field (no `option`) are rendered. Each line shows the
 *   runtime condition and the action (the branch's `description`, falling
 *   back to "stop the flow" for `next: null` or "continue" otherwise).
 *
 * Runtime `when` and user-facing `option` branches are intentionally
 * separate placeholders - the agent presents `{{branches}}` to the user
 * via its choice prompt, and reads `{{whens}}` to itself when routing on
 * observed state.
 *
 * Both line kinds end with "→ destination" (from `destinationFor`) so the
 * agent reads where each route goes instead of inferring the wiring from
 * surrounding prose; `{{whens}}` lines whose action already says "stop the
 * flow" skip the redundant "→ stop".
 */
function expandBranchesPlaceholders(
  step: Step,
  sourcePhaseId: string,
  target: TargetName,
  destinationFor?: DestinationFor,
): string {
  const body = s(step.body, target, `step[${step.id}].body`)
  if (step.kind !== "branch") {
    return body
  }
  return body
    .replace(
      /\{\{branches(?::([a-z0-9-]+))?\}\}/g,
      (_match, promptFilter: string | undefined) => {
        const lines: string[] = []
        for (const branch of step.branches) {
          if (branch.option === undefined) {
            continue
          }
          if (promptFilter !== undefined && branch.prompt !== promptFilter) {
            continue
          }
          const { letter, label, description } = branch.option
          const recommended =
            branch.recommended === true ? " *(recommended)*" : ""
          const desc = description !== undefined ? `: ${description}` : ""
          const dest =
            destinationFor !== undefined
              ? ` → ${destinationFor(branch.next, sourcePhaseId)}`
              : ""
          lines.push(`> ${letter}) **${label}**${desc}${recommended}${dest}`)
        }
        return lines.join("\n")
      },
    )
    .replace(/\{\{whens\}\}/g, () => {
      const lines: string[] = []
      for (const branch of step.branches) {
        if (branch.when === undefined || branch.option !== undefined) {
          continue
        }
        const action =
          branch.description ??
          (branch.next === null ? "stop the flow" : "continue")
        const dest =
          destinationFor !== undefined && branch.next !== null
            ? ` → ${destinationFor(branch.next, sourcePhaseId)}`
            : ""
        lines.push(`- **${branch.when}**: ${action}${dest}`)
      }
      return lines.join("\n")
    })
}

function renderPhaseAsHeaders(
  phase: Phase,
  visibleSteps: { step: Step; stepKey: string }[],
  allModes: string[],
  modesPerStep: Map<string, Set<string>>,
  target: TargetName,
  emitTemplate: string | undefined,
  dispatchSuffixFor?: DispatchSuffixFor,
  destinationFor?: DestinationFor,
  stepNumberOffset = 0,
  // Headers-style phases render no phase heading, so a single-mode `phaseGate`
  // has nothing to sit under and floats above the first step. In a split-chain
  // orchestrator that float lands right under the `## Dispatch` block and reads
  // as gating the dispatch. When true, fold the gate under the first step's
  // heading instead (where mixed-mode phases already put their per-step gates).
  // Only the orchestrator inline call sets this; monolith and sub-skills keep
  // the historical float (no `## Dispatch` precedes it there, so it's clear).
  foldSingleModeGate = false,
): string {
  const blocks: string[] = []
  const stepKeys = visibleSteps.map((v) => v.stepKey)
  const { phaseGate, perStepGates } = precomputePhaseAndStepGates(
    stepKeys,
    modesPerStep,
    allModes,
  )
  if (phaseGate !== null && !foldSingleModeGate) {
    blocks.push(phaseGate)
  }
  if (phase.intro !== undefined) {
    const intro = s(phase.intro, target, `phase[${phase.id}].intro`)
    if (intro.length > 0) {
      blocks.push(intro)
    }
  }

  let counter = 1 + stepNumberOffset
  let firstStep = true
  for (const { step, stepKey } of visibleSteps) {
    const number = step.preamble === true ? 0 : counter
    if (step.preamble !== true) {
      counter += 1
    }
    const title = s(step.title, target, `step[${step.id}].title`)
    let body = bodyWithModeGate(
      step,
      stepKey,
      perStepGates,
      target,
      emitTemplate,
      dispatchSuffixFor,
      destinationFor,
    )
    if (firstStep && foldSingleModeGate && phaseGate !== null) {
      body = `${phaseGate}\n\n${body}`
    }
    firstStep = false
    blocks.push(`## ${number}. ${title}\n\n${body}`)
  }

  if (phase.outro !== undefined) {
    const outro = s(phase.outro, target, `phase[${phase.id}].outro`)
    if (outro.length > 0) {
      blocks.push(outro)
    }
  }

  return blocks.join("\n\n")
}

function renderPhaseAsList(
  phase: Phase,
  visibleSteps: { step: Step; stepKey: string }[],
  allModes: string[],
  modesPerStep: Map<string, Set<string>>,
  target: TargetName,
  emitTemplate: string | undefined,
  includePhaseTitle: boolean,
  dispatchSuffixFor?: DispatchSuffixFor,
  destinationFor?: DestinationFor,
  stepNumberOffset = 0,
): string {
  const blocks: string[] = []
  if (includePhaseTitle) {
    blocks.push(`## ${s(phase.title, target, `phase[${phase.id}].title`)}`)
  }
  const stepKeys = visibleSteps.map((v) => v.stepKey)
  const { phaseGate, perStepGates } = precomputePhaseAndStepGates(
    stepKeys,
    modesPerStep,
    allModes,
  )
  if (phaseGate !== null) {
    blocks.push(phaseGate)
  }
  if (phase.intro !== undefined) {
    const intro = s(phase.intro, target, `phase[${phase.id}].intro`)
    if (intro.length > 0) {
      blocks.push(intro)
    }
  }

  const items: string[] = []
  let counter = 1 + stepNumberOffset
  for (const { step, stepKey } of visibleSteps) {
    const number = step.preamble === true ? 0 : counter
    if (step.preamble !== true) {
      counter += 1
    }
    const body = bodyWithModeGate(
      step,
      stepKey,
      perStepGates,
      target,
      emitTemplate,
      dispatchSuffixFor,
      destinationFor,
    )
    items.push(`${number}. ${indentBody(body)}`)
  }
  blocks.push(items.join("\n"))

  if (phase.outro !== undefined) {
    const outro = s(phase.outro, target, `phase[${phase.id}].outro`)
    if (outro.length > 0) {
      blocks.push(outro)
    }
  }

  return blocks.join("\n\n")
}

function indentBody(body: string): string {
  const lines = body.split("\n")
  return lines
    .map((line, i) => (i === 0 ? line : line.length > 0 ? `   ${line}` : line))
    .join("\n")
}

/**
 * Resolve target sections: `{{#name}}…{{/name}}` keeps its content only for
 * targets in section `name`, `{{^name}}…{{/name}}` only for targets outside
 * it. Every target name is a section of itself; kits add named groups.
 */
export function applyMustacheSections(
  text: string,
  target: Pick<RenderTarget, "sections">,
): string {
  const sectionRegex = /\{\{([#^])([a-z][a-z0-9-]*)\}\}([\s\S]*?)\{\{\/\2\}\}/g
  return text.replace(
    sectionRegex,
    (_match, kind: string, name: string, inner: string) => {
      const isMatch = target.sections[name]
      if (isMatch === undefined) {
        throw new Error(
          `Unknown section "${name}". Valid sections: ${Object.keys(target.sections).join(", ")}.`,
        )
      }
      const include = kind === "#" ? isMatch : !isMatch
      return include ? inner : ""
    },
  )
}

/**
 * Modes that can reach the phases compiled into one file. `undefined`
 * `unitPhases` means the monolith, which every mode reads.
 */
function modesReachingUnit(
  flow: Flow,
  targetName: TargetName,
  unitPhases?: Set<string>,
): Set<string> {
  if (unitPhases === undefined) {
    return new Set(Object.keys(flow.entries))
  }
  const reaching = new Set<string>()
  for (const [stepId, modes] of computeModesPerStep(flow, targetName)) {
    if (!unitPhases.has(stepId.split("/")[0] as string)) {
      continue
    }
    for (const mode of modes) {
      reaching.add(mode)
    }
  }
  return reaching
}

/**
 * Resolve per-mode sections (`{{#mode:x}}…{{/mode:x}}` and `{{^mode:x}}…`).
 *
 * A target section always resolves away, because the renderer emits one file
 * per target. A mode section cannot always: under split-chain a sub-skill is
 * dispatched with a mode, and the same file serves every mode that dispatches
 * into it. So this resolves statically where the file's reachable-mode set
 * decides the branch, and otherwise emits an explicit gate the agent applies
 * at run time:
 *
 * - mode unreachable here: `#` drops (dead content, e.g. an `analyze-repo`
 *   section inside a phase `analyze-repo` never enters), `^` unwraps.
 * - mode is the file's ONLY mode: `#` unwraps, `^` drops.
 * - otherwise: unwrap under a bolded "Only when the mode is `x`" gate.
 *
 * Runs after target sections and before flow-data placeholders, so a
 * statically dropped section never has its `{{step:...}}` refs evaluated.
 */
function applyModeSections(
  text: string,
  flow: Flow,
  targetName: TargetName,
  unitPhases?: Set<string>,
): string {
  if (!MODE_SECTION_RE.test(text)) {
    MODE_SECTION_RE.lastIndex = 0
    return text
  }
  MODE_SECTION_RE.lastIndex = 0
  const reachable = modesReachingUnit(flow, targetName, unitPhases)
  const sectionRegex =
    /\{\{([#^])mode:([a-z0-9-]+)\}\}([\s\S]*?)\{\{\/mode:\2\}\}/g
  return text.replace(
    sectionRegex,
    (
      _match,
      kind: string,
      mode: string,
      inner: string,
      offset: number,
    ): string => {
      const body = inner.trim()
      const applies = reachable.has(mode)
      const isOnlyMode = applies && reachable.size === 1
      if (kind === "#" && !applies) {
        return ""
      }
      if (kind === "^" && isOnlyMode) {
        return ""
      }
      if ((kind === "#" && isOnlyMode) || (kind === "^" && !applies)) {
        return body
      }
      // `indentBody` has already run, so the section's own line carries the
      // list indent but the gate line and the body's first line would start at
      // column 0 and break out of the list item. Re-apply the indent when the
      // marker leads its line; a mid-line marker keeps the line it is on.
      const lineStart = text.lastIndexOf("\n", offset - 1) + 1
      const before = text.slice(lineStart, offset)
      const indent = /^[ \t]*$/.test(before) ? before : ""
      const gate =
        kind === "#"
          ? `**Only when the mode is \`${mode}\`:**`
          : `**Unless the mode is \`${mode}\`:**`
      return `${gate}\n\n${indent}${body}`
    },
  )
}

/**
 * Resolve target tokens (cmd, editor, etc.) and flow variables, then sanity-
 * check that no `{{...}}` placeholder slipped through. Runs AFTER Mustache
 * sections and flow-data placeholders.
 */
function applyTokens(text: string, target: RenderTarget, flow: Flow): string {
  // Build a unified substitution pool: target tokens + flow variables.
  // Variables that collide with target tokens are caught at parse time by
  // the schema's superRefine, so this loop never throws in practice.
  const pool: Record<string, string> = {
    ...target.tokens,
    argsToken: target.argsToken,
  }
  for (const [name, value] of Object.entries(flow.variables)) {
    pool[name] = s(value, target.name, `flow.variables.${name}`)
  }

  const tokenRegex = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g
  const result = text.replace(
    tokenRegex,
    (_match, key: string, offset: number) => {
      if (!Object.hasOwn(pool, key)) {
        throw new Error(
          `Unresolved placeholder {{${key}}} - not a target token or flow variable. Define it in flow.variables, fix the typo, or remove the placeholder.`,
        )
      }
      // A multi-line variable expands after list bodies were indented, so
      // carry the placeholder's indent onto its continuation lines.
      return inheritLineIndent(text, offset, pool[key] as string)
    },
  )

  // Final sanity scan - any leftover `{{...}}` is a malformed or unknown
  // namespaced placeholder that no earlier pass recognized.
  const leftovers = result.match(/\{\{[^}]+\}\}/g)
  if (leftovers) {
    throw new Error(
      `Unresolved placeholder(s): ${leftovers.join(", ")}. Check spelling and namespace (step:, step-ref:, skill-ref:, dispatch-ref:, tool:, command:, table:, list:, branches, branches:).`,
    )
  }

  return result
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`
}

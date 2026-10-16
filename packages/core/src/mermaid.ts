import type { Flow, Step } from "./schema.js"
import {
  branchLabel,
  computeModesPerStep,
  computeReachableSteps,
  nextRefsForMode,
  resolvePerTarget,
  type Targetable,
} from "./schema.js"

export interface DiagramOptions {
  /** Restrict the diagram to steps reachable in this mode. */
  mode?: string
  /**
   * Target whose per-target values (titles, entries) the diagram shows.
   * Defaults to each value's `default`, falling back to its first variant.
   */
  target?: string
}

function diagramValue<T>(
  value: Targetable<T>,
  target: string | undefined,
): T | undefined {
  const resolved = resolvePerTarget(value, target ?? "default")
  if (resolved !== undefined || typeof value !== "object" || value === null) {
    return resolved
  }
  return Object.values(value as Record<string, T | undefined>).find(
    (v) => v !== undefined,
  )
}

function diagramString(
  value: Targetable<string>,
  target: string | undefined,
): string {
  return diagramValue(value, target) ?? ""
}

/** Target used for reachability; the first entry key covers per-target entries. */
function reachabilityTarget(flow: Flow, target: string | undefined): string {
  if (target !== undefined) {
    return target
  }
  for (const entry of Object.values(flow.entries)) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      entry.default === undefined
    ) {
      const first = Object.keys(entry)[0]
      if (first !== undefined) {
        return first
      }
    }
  }
  return "default"
}

/**
 * Produce a Mermaid flowchart from the flow's schema alone - no prose or
 * body content is read. Each mode is rendered as a labeled edge so a viewer
 * can see exactly where the modes diverge.
 *
 * The graph derives entirely from `entries`, `next`, `branches`, and `loop`
 * targets. If the diagram looks wrong, the schema is wrong - there is no
 * prose to disagree with.
 */
export function renderMermaid(
  flow: Flow,
  // A bare string is shorthand for `{ mode }`.
  options: DiagramOptions | string = {},
): string {
  const { mode, target } =
    typeof options === "string" ? { mode: options, target: undefined } : options
  const graphTarget = reachabilityTarget(flow, target)
  const lines: string[] = ["flowchart TD"]

  const stepById = new Map<string, Step>()
  for (const phase of flow.phases) {
    for (const step of phase.steps) {
      stepById.set(`${phase.id}/${step.id}`, step)
    }
  }
  const nodeId = (key: string) => key.replace(/[^a-zA-Z0-9]/g, "_")

  const allModes = Object.keys(flow.entries)
  const activeModes = mode !== undefined ? [mode] : allModes

  // When filtering to a single mode, only show steps reachable in that mode.
  // Without a filter, show the union of all modes (existing behavior).
  const reachable =
    mode !== undefined
      ? new Set(
          [...computeModesPerStep(flow, graphTarget).entries()]
            .filter(([, modes]) => modes.has(mode))
            .map(([key]) => key),
        )
      : computeReachableSteps(flow, graphTarget)

  for (const phase of flow.phases) {
    const phaseSteps = phase.steps.filter((s) =>
      reachable.has(`${phase.id}/${s.id}`),
    )
    if (phaseSteps.length === 0) {
      continue
    }
    const phaseTitle = escapeMermaidLabel(diagramString(phase.title, target))
    lines.push(`  subgraph ${nodeId(phase.id)}["${phaseTitle}"]`)
    let counter = 1
    for (const step of phaseSteps) {
      const stepKey = `${phase.id}/${step.id}`
      const id = nodeId(stepKey)
      const baseLabel = escapeMermaidLabel(diagramString(step.title, target))
      const num = step.preamble === true ? 0 : counter
      if (step.preamble !== true) {
        counter += 1
      }
      const label = `${num}. ${baseLabel}`
      const fork = forkClass(step)
      const cls = fork ?? "step"
      lines.push(`    ${id}["${label}"]:::${cls}`)
    }
    lines.push("  end")
  }

  const seenLinearEdges = new Set<string>()
  const isReachable = (ref: string): boolean => reachable.has(ref)
  for (const phase of flow.phases) {
    for (const step of phase.steps) {
      const src = `${phase.id}/${step.id}`
      if (!isReachable(src)) {
        continue
      }
      if (
        step.kind === "action" ||
        step.kind === "reference" ||
        step.kind === "parallel"
      ) {
        if (step.next === null || typeof step.next === "string") {
          if (step.next !== null && isReachable(step.next)) {
            const edge = `${src}->${step.next}`
            if (!seenLinearEdges.has(edge)) {
              seenLinearEdges.add(edge)
              lines.push(`  ${nodeId(src)} --> ${nodeId(step.next)}`)
            }
          }
        } else {
          for (const m of activeModes) {
            const target = step.next.byMode[m] ?? null
            if (target === null || !isReachable(target)) {
              continue
            }
            if (mode !== undefined) {
              const edge = `${src}->${target}`
              if (!seenLinearEdges.has(edge)) {
                seenLinearEdges.add(edge)
                lines.push(`  ${nodeId(src)} --> ${nodeId(target)}`)
              }
            } else {
              lines.push(
                `  ${nodeId(src)} -->|"${escapeMermaidLabel(m)}"| ${nodeId(target)}`,
              )
            }
          }
        }
      } else if (step.kind === "branch") {
        for (const branch of step.branches) {
          const baseLabel = branchLabel(branch)
          const labelWithRec = branch.recommended
            ? `${baseLabel} (recommended)`
            : baseLabel
          if (branch.next === null || typeof branch.next === "string") {
            if (branch.next !== null && !isReachable(branch.next)) {
              continue
            }
            const target =
              branch.next === null ? "flow_end" : nodeId(branch.next)
            lines.push(
              `  ${nodeId(src)} -->|"${escapeMermaidLabel(labelWithRec)}"| ${target}`,
            )
          } else {
            for (const m of activeModes) {
              const dest = branch.next.byMode[m] ?? null
              if (dest !== null && !isReachable(dest)) {
                continue
              }
              const target = dest === null ? "flow_end" : nodeId(dest)
              if (mode !== undefined) {
                lines.push(
                  `  ${nodeId(src)} -->|"${escapeMermaidLabel(labelWithRec)}"| ${target}`,
                )
              } else {
                const modeLabel = `${labelWithRec} [${m}]`
                lines.push(
                  `  ${nodeId(src)} -->|"${escapeMermaidLabel(modeLabel)}"| ${target}`,
                )
              }
            }
          }
        }
      } else if (step.kind === "loop") {
        if (isReachable(step.backTo)) {
          lines.push(
            `  ${nodeId(src)} -.->|"until ${escapeMermaidLabel(step.exitWhen)}"| ${nodeId(step.backTo)}`,
          )
        }
        if (isReachable(step.onExit)) {
          lines.push(`  ${nodeId(src)} -->|"exit"| ${nodeId(step.onExit)}`)
        }
      }
    }
  }

  if (lines.some((l) => l.includes("flow_end"))) {
    lines.push("  flow_end((end)):::terminal")
    lines.push("  classDef terminal fill:#3a1f1f,stroke:#d96a6a,color:#ffd7d7")
  }

  const entryNodeIds: string[] = []
  for (const m of activeModes) {
    const entry = flow.entries[m]
    if (entry === undefined) {
      continue
    }
    const resolved = diagramValue(entry, target)
    if (resolved === undefined) {
      continue
    }
    const startId = `start_${nodeId(m)}`
    const isDefault = flow.defaultMode === m
    const label = isDefault ? `${m} (default)` : m
    lines.push(`  ${startId}(("${escapeMermaidLabel(label)}")):::entry`)
    lines.push(`  ${startId} --> ${nodeId(resolved)}`)
    entryNodeIds.push(startId)
  }
  if (entryNodeIds.length > 1) {
    lines.push(`  ${entryNodeIds.join(" ~~~ ")}`)
  }
  lines.push("  classDef entry fill:#1f3a1f,stroke:#5bd58e,color:#d6ffe2")
  lines.push("  classDef step fill:#262626,stroke:#666,color:#e0e0e0")
  lines.push("  classDef modeFork fill:#1f2a3a,stroke:#7aa2d9,color:#cfe1ff")
  lines.push(
    "  classDef userDecision fill:#2a1f3a,stroke:#b58be0,color:#e8d6ff",
  )
  lines.push(
    "  classDef agentDecision fill:#3a2a1f,stroke:#e0a35b,color:#ffe1c7",
  )

  return lines.join("\n")
}

type BranchStep = Extract<Step, { kind: "branch" }>

/**
 * Three fork kinds:
 *   - **mode fork** - an action/reference/parallel step whose `next` is a
 *     `byMode` map: the flow takes different paths per invocation mode
 *     (the edges fan out, one per mode label).
 *   - **user decision** - a `branch` step whose options are tagged with
 *     `option` (rendered as A/B/C in the choice prompt).
 *   - **agent decision** - a `branch` step whose options are tagged with
 *     `when` runtime conditions (the agent picks at runtime, no prompt).
 *
 * Mixed branches (some `option`, some `when`) classify as user-decision
 * since the prompt dominates the user-facing experience.
 */
function forkClass(
  step: Step,
): "modeFork" | "userDecision" | "agentDecision" | null {
  if (step.kind === "branch") {
    return branchForkClass(step)
  }
  if (
    step.kind === "action" ||
    step.kind === "reference" ||
    step.kind === "parallel"
  ) {
    if (typeof step.next === "object" && step.next !== null) {
      return "modeFork"
    }
  }
  return null
}

function branchForkClass(step: BranchStep): "userDecision" | "agentDecision" {
  const hasOption = step.branches.some((b) => b.option !== undefined)
  return hasOption ? "userDecision" : "agentDecision"
}

function escapeMermaidLabel(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/\|/g, "&#124;")
}

/**
 * Plain-text adjacency dump for quick inspection. Lists each step and its
 * outgoing edges grouped by mode - useful for snapshot tests and as a sanity
 * check that the schema's graph matches expectations.
 */
export function describeFlow(flow: Flow, target?: string): string {
  const lines: string[] = []
  const title = diagramString(flow.title, target)
  lines.push(`Flow: ${flow.id} (${title})`)
  if (flow.defaultMode !== undefined) {
    lines.push(`Default mode: ${flow.defaultMode}`)
  }
  lines.push("Entries:")
  for (const [mode, entry] of Object.entries(flow.entries)) {
    const resolved = diagramValue(entry, target)
    lines.push(`  ${mode} → ${resolved ?? "<no entry for diagram target>"}`)
  }
  lines.push("")

  for (const phase of flow.phases) {
    lines.push(`Phase: ${phase.id}`)
    for (const step of phase.steps) {
      const key = `${phase.id}/${step.id}`
      lines.push(`  ${key} [${step.kind}]`)
      const modes = Object.keys(flow.entries)
      for (const mode of modes) {
        const targets = nextRefsForMode(step, mode)
        const desc = targets.map((t) => t ?? "<end>").join(", ")
        lines.push(`    ${mode} → ${desc}`)
      }
    }
  }

  return lines.join("\n")
}

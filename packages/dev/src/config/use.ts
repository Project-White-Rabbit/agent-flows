// What a team uses an integration for: per capability it provides, how far
// flows may go with it (`"issueTracker": "track"`), or `true` for a capability
// without levels. Team policy, so it's committed with the rest of the entry
// under `use`, unlike how each machine reaches the integration.
//
// Runtime code: Node built-ins only.

import { CAPABILITIES } from "./capabilities.ts"
import type { CapabilitySpec, SectionSpec, SectionValues } from "./types.ts"

/** The key on an integration entry (or instance) that holds its use. */
export const USE_KEY = "use"

export type Use = Record<string, string | true>

function provided(spec: SectionSpec): string[] {
  return "provides" in spec ? Object.keys(spec.provides as object) : []
}

function capabilityOf(
  id: string,
  capabilities: CapabilitySpec[],
): CapabilitySpec | undefined {
  return capabilities.find((c) => c.id === id)
}

/** Problems with an entry's `use`, reported at `where`. */
export function checkUse(
  spec: SectionSpec,
  value: unknown,
  where: string,
  capabilities: CapabilitySpec[] = CAPABILITIES,
): string[] {
  const provides = provided(spec)
  if (provides.length === 0) {
    return [`${where} isn't allowed: ${spec.path} isn't an integration`]
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [
      `${where} must be an object of capability to level, like {"${provides[0]}": ${levelExample(provides[0], capabilities)}}`,
    ]
  }
  const issues: string[] = []
  for (const [id, level] of Object.entries(value)) {
    if (!provides.includes(id)) {
      issues.push(
        `${where}.${id}: ${spec.name} doesn't provide ${id} (it provides ${provides.join(", ")})`,
      )
      continue
    }
    const levels = capabilityOf(id, capabilities)?.levels
    if (levels) {
      if (!levels.some((l) => l.id === level)) {
        issues.push(
          `${where}.${id} must be one of ${levels.map((l) => `"${l.id}"`).join(", ")}`,
        )
      }
    } else if (level !== true) {
      issues.push(`${where}.${id} must be true (${id} has no levels)`)
    }
  }
  return issues
}

function levelExample(id: string, capabilities: CapabilitySpec[]): string {
  const levels = capabilityOf(id, capabilities)?.levels
  return levels ? `"${levels[0].id}"` : "true"
}

/** Capabilities the integration provides only when `use` names them. */
export function optInOf(spec: SectionSpec): string[] {
  return "optIn" in spec ? (spec.optIn as string[]) : []
}

/**
 * What an entry is used for: its `use`, or, when it doesn't say, every
 * capability it provides at that capability's default level, except the
 * ones it provides only on opt-in.
 */
export function usesOf(
  spec: SectionSpec,
  values: SectionValues,
  capabilities: CapabilitySpec[] = CAPABILITIES,
): Use {
  const declared = (values as Record<string, unknown>)[USE_KEY]
  if (typeof declared === "object" && declared !== null) {
    return declared as Use
  }
  const optIn = optInOf(spec)
  return Object.fromEntries(
    provided(spec)
      .filter((id) => !optIn.includes(id))
      .map((id) => {
        const capability = capabilityOf(id, capabilities)
        return [
          id,
          capability?.levels
            ? (capability.defaultLevel ?? capability.levels[0].id)
            : true,
        ]
      }),
  )
}

/** The entry's values without `use`, which flows read as `level` instead. */
export function withoutUse(values: SectionValues): SectionValues {
  const { [USE_KEY]: _, ...rest } = values as Record<string, unknown>
  return rest as SectionValues
}

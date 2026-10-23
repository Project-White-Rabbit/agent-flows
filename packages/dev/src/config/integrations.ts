// Resolving capabilities to the integrations a config has for them. A flow
// asks for `sourceControl` and gets every configured integration that provides
// it (one entry per instance, for an integration configured more than once),
// each with its values and its ops filled in, so the flow never names a vendor.

import { CAPABILITIES } from "./capabilities.ts"
import { getAt, INSTANCE_KEY, instancesOf, type RawConfig } from "./config.ts"
import { INTEGRATIONS } from "./sections/index.ts"
import type { CapabilitySpec, IntegrationSpec, SectionValues } from "./types.ts"

export function integrationId(spec: IntegrationSpec): string {
  return spec.path.split(".").at(-1) as string
}

export function findCapability(
  id: string,
  capabilities: CapabilitySpec[] = CAPABILITIES,
): CapabilitySpec | undefined {
  return capabilities.find((c) => c.id.toLowerCase() === id.toLowerCase())
}

/** Integrations that provide `capability`, configured or not, in registry order. */
export function providersOf(
  capability: string,
  integrations: IntegrationSpec[] = INTEGRATIONS,
): IntegrationSpec[] {
  return integrations.filter((spec) => capability in spec.provides)
}

/** `{field}`, `{field|default}`, and either with `:encoded`, in an op. */
export const OP_PLACEHOLDER = /\{(\w+)(?:\|([a-z0-9.-]+))?(:encoded)?\}/g

/**
 * Replace each placeholder with the configured value (or its default when the
 * field is unset), URL-encoded for `:encoded`.
 */
export function fillOps(
  ops: Record<string, string>,
  values: SectionValues,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ops).map(([op, how]) => [
      op,
      how.replace(
        OP_PLACEHOLDER,
        (whole, key: string, fallback?: string, encoded?: string) => {
          const value = values[key] ?? fallback
          if (typeof value !== "string") {
            return whole
          }
          return encoded ? encodeURIComponent(value) : value
        },
      ),
    ]),
  )
}

export type ResolvedIntegration = {
  integration: string
  /** Which one, when the integration is configured more than once. */
  instance?: string
  name: string
  path: string
  values: SectionValues
  ops: Record<string, string>
}

export type CapabilityResolution = {
  /** Every configured provider, in registry order. Flows use all of them. */
  configured: ResolvedIntegration[]
  /** Providers the team declined (listed in `skipped`). */
  skipped: string[]
  /** Providers neither configured nor skipped. */
  unconfigured: string[]
}

export function resolveCapability(
  config: RawConfig,
  capability: string,
  integrations: IntegrationSpec[] = INTEGRATIONS,
): CapabilityResolution {
  const skippedPaths = Array.isArray(config.skipped)
    ? (config.skipped as string[])
    : []
  const out: CapabilityResolution = {
    configured: [],
    skipped: [],
    unconfigured: [],
  }
  for (const spec of providersOf(capability, integrations)) {
    const id = integrationId(spec)
    const entry = getAt(config, spec.path)
    const instances = instancesOf(entry)
    if (instances.length > 0) {
      for (const values of instances) {
        out.configured.push({
          integration: id,
          ...(Array.isArray(entry)
            ? { instance: String(values[INSTANCE_KEY]) }
            : {}),
          name: spec.name,
          path: spec.path,
          values,
          ops: fillOps(spec.provides[capability], values),
        })
      }
    } else if (skippedPaths.includes(spec.path)) {
      out.skipped.push(id)
    } else {
      out.unconfigured.push(id)
    }
  }
  return out
}

/**
 * Configured integrations per capability, what the repo covers: `vercel`, or
 * `vercel:web` per instance.
 */
export function coverage(
  config: RawConfig,
  capabilities: CapabilitySpec[] = CAPABILITIES,
  integrations: IntegrationSpec[] = INTEGRATIONS,
): Record<string, string[]> {
  return Object.fromEntries(
    capabilities.map((c) => [
      c.id,
      resolveCapability(config, c.id, integrations).configured.map((r) =>
        r.instance ? `${r.integration}:${r.instance}` : r.integration,
      ),
    ]),
  )
}

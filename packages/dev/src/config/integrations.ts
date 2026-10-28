// Resolving capabilities to the integrations a config has for them. A flow
// asks for `sourceControl` and gets every configured integration that provides
// it (one entry per instance, for an integration configured more than once),
// each with its values and its ops filled in, so the flow never names a vendor.

import path from "node:path"
import { type AccessReport, accessKey } from "./access.ts"
import type { LoadedAdapter } from "./adapters/index.ts"
import { CAPABILITIES } from "./capabilities.ts"
import { getAt, INSTANCE_KEY, instancesOf, type RawConfig } from "./config.ts"
import { INTEGRATIONS } from "./sections/index.ts"
import type {
  CapabilitySpec,
  IntegrationSpec,
  OpImpl,
  SectionValues,
} from "./types.ts"
import { usesOf, withoutUse } from "./use.ts"

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

/** Where an API op puts the token: a shell expression, filled at resolution. */
export const TOKEN_PLACEHOLDER = "{token}"

/**
 * Replace each placeholder with the configured value (or its default when the
 * field is unset), URL-encoded for `:encoded`, and `{token}` with the API
 * token's variable.
 */
export function fillOps(
  ops: Record<string, OpImpl>,
  values: SectionValues,
  /** The token's shell expression (`$LINEAR_API_KEY`, `$(cat '/path')`). */
  token?: string,
): Record<string, OpImpl> {
  const fill = (how: string) => {
    const filled = how.replace(
      OP_PLACEHOLDER,
      (whole, key: string, fallback?: string, encoded?: string) => {
        if (key === "token" && !fallback && !encoded) {
          return whole
        }
        const value = values[key] ?? fallback
        if (typeof value !== "string") {
          return whole
        }
        return encoded ? encodeURIComponent(value) : value
      },
    )
    return token ? filled.replaceAll(TOKEN_PLACEHOLDER, token) : filled
  }
  return Object.fromEntries(
    Object.entries(ops).map(([op, how]) => [
      op,
      typeof how === "string"
        ? fill(how)
        : Object.fromEntries(
            Object.entries(how).map(([kind, text]) => [kind, fill(text)]),
          ),
    ]),
  )
}

/** The command that runs adapters. */
export const ADAPTER_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "commands",
  "adapter.ts",
)

/** The `script` variant of an op that has an adapter. */
export function scriptVariant(
  integration: string,
  instance: string | undefined,
  op: string,
  { adapter, source }: LoadedAdapter,
): string {
  const args = [
    ...(adapter.args ?? []).map((a) => ` --${a} <${a}>`),
    ...(adapter.optional ?? []).map((a) => ` [--${a} <${a}>]`),
  ].join("")
  const target = instance ? ` --instance ${instance}` : ""
  const needs = adapter.needs
    ? ` It needs ${adapter.needs === "api" ? "the API token (`access.api.ready`)" : "the CLI (`access.cli.ready`)"}.`
    : ""
  return `\`node "${ADAPTER_SCRIPT}" run ${integration} ${op}${target}${args}\` (${source === "repo" ? "the repo's adapter" : "built-in adapter"}): prints JSON. Exit 3 means it can't run on this machine (it says why): use the next variant.${needs}`
}

export type ResolvedIntegration = {
  integration: string
  /** Which one, when the integration is configured more than once. */
  instance?: string
  name: string
  path: string
  /** How far the team lets flows go with it here, for a capability with levels. */
  level?: string
  values: SectionValues
  /** How this machine can reach it, when it was probed. */
  access?: AccessReport
  ops: Record<string, OpImpl>
}

/** Put a `script` variant first on every op that has an adapter. */
function withScripts(
  ops: Record<string, OpImpl>,
  variant: (op: string, loaded: LoadedAdapter) => string,
  adapters: Record<string, LoadedAdapter>,
): Record<string, OpImpl> {
  return Object.fromEntries(
    Object.entries(ops).map(([op, impl]) => {
      const loaded = adapters[op]
      if (!loaded) {
        return [op, impl]
      }
      // A repo's adapter for an op the tool has nothing for is the only way.
      const rest = typeof impl === "string" || "unsupported" in impl ? {} : impl
      return [op, { script: variant(op, loaded), ...rest }]
    }),
  )
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
  access: Record<string, AccessReport> = {},
  scripts: Record<string, Record<string, LoadedAdapter>> = {},
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
        // Configured, but the team doesn't use it for this capability.
        const level = usesOf(spec, values)[capability]
        if (level === undefined) {
          continue
        }
        const instance = Array.isArray(entry)
          ? String(values[INSTANCE_KEY])
          : undefined
        const reach =
          access[accessKey(spec.path, instance)] ?? access[spec.path]
        out.configured.push({
          integration: id,
          ...(instance ? { instance } : {}),
          name: spec.name,
          path: spec.path,
          ...(typeof level === "string" ? { level } : {}),
          values: withoutUse(values),
          ...(reach ? { access: reach } : {}),
          ops: withScripts(
            fillOps(
              spec.provides[capability],
              values,
              reach?.api?.expression ??
                (spec.access.api ? `$${spec.access.api.token[0]}` : undefined),
            ),
            (op, loaded) => scriptVariant(id, instance, op, loaded),
            scripts[spec.path] ?? {},
          ),
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

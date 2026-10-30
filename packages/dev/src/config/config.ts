// Reading, checking, patching, and planning .agent-flows/config.json, generic
// over the section registry. Nothing here knows about a particular service.
//
// Compatibility rules, so the format can grow:
// - `version` is the format. Older files are migrated forward on read; a newer
//   one is rejected with "upgrade the plugin" rather than misread.
// - Sections and fields this plugin doesn't know (written by a newer plugin, or
//   by hand) are warnings, not errors, and writes keep them untouched.
// - Known fields are strict: wrong types and missing required fields are
//   errors, and a write can never introduce an unknown section.

import { checkHooks } from "./hooks.ts"
import { freeInstanceName, INSTANCE_KEY, INSTANCE_NAME } from "./instances.ts"
import { SECTIONS } from "./sections/index.ts"
import type {
  Detection,
  FieldSpec,
  FieldValue,
  Migration,
  SectionEntry,
  SectionSpec,
  SectionValues,
} from "./types.ts"
import { checkUse, USE_KEY } from "./use.ts"

export const CONFIG_PATH = ".agent-flows/config.json"

export { INSTANCE_KEY }
export const CONFIG_VERSION = 3

/** Upgrades from each older version. */
export const MIGRATIONS: Migration[] = [
  {
    // `services.<id>` became `integrations.<id>` when integrations started
    // declaring the capabilities they provide.
    from: 1,
    migrate({ services, ...rest }) {
      const out: RawConfig =
        services === undefined ? rest : { ...rest, integrations: services }
      if (Array.isArray(out.skipped)) {
        out.skipped = out.skipped.map((p: unknown) =>
          typeof p === "string" ? p.replace(/^services\./, "integrations.") : p,
        )
      }
      return out
    },
  },
  {
    // `merge.closeIssue` became `merge.issueOnMerge` when a team could leave
    // the issue to the tracker's integration or leave it open. False meant
    // leaving it open for the teams that set it.
    from: 2,
    migrate(config) {
      const merge = config.merge
      if (isRecord(merge) && "closeIssue" in merge) {
        const { closeIssue, ...rest } = merge
        config.merge =
          typeof closeIssue === "boolean"
            ? { ...rest, issueOnMerge: closeIssue ? "close" : "leave" }
            : merge
      }
      if (Array.isArray(config.skipped)) {
        config.skipped = config.skipped.map((p: unknown) =>
          p === "merge.closeIssue" ? "merge.issueOnMerge" : p,
        )
      }
      return config
    },
  },
]

export type RawConfig = Record<string, unknown>

/** A config that passed `checkConfig`: known sections are well-formed. */
export type Config = RawConfig & { version: number; skipped?: string[] }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function getAt(config: RawConfig, path: string): unknown {
  let node: unknown = config
  for (const part of path.split(".")) {
    if (!isRecord(node)) {
      return undefined
    }
    node = node[part]
  }
  return node
}

function setAt(config: RawConfig, path: string, value: unknown): void {
  const parts = path.split(".")
  let node = config
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(node[part])) {
      node[part] = {}
    }
    node = node[part] as RawConfig
  }
  node[parts.at(-1) as string] = value
}

function deleteAt(config: RawConfig, path: string): void {
  const parts = path.split(".")
  const parent = getAt(config, parts.slice(0, -1).join("."))
  const target = parts.length === 1 ? config : parent
  if (isRecord(target)) {
    delete target[parts.at(-1) as string]
  }
}

/** Container paths (`integrations`) implied by section paths, top-down. */
function containerPaths(registry: SectionSpec[]): string[] {
  const out = new Set<string>()
  for (const { path } of registry) {
    const parts = path.split(".")
    for (let i = 1; i < parts.length; i++) {
      out.add(parts.slice(0, i).join("."))
    }
  }
  return [...out]
}

/** Run migrations up to the current version. */
export function migrate(
  raw: RawConfig,
  migrations: Migration[] = MIGRATIONS,
  target = CONFIG_VERSION,
): { config?: RawConfig; issues: string[] } {
  if (raw.version === undefined) {
    return { issues: [`version is required (current: ${target})`] }
  }
  if (!Number.isInteger(raw.version)) {
    return { issues: ["version must be an integer"] }
  }
  let config = raw
  let version = raw.version as number
  if (version > target) {
    return {
      issues: [
        `config is version ${version}, newer than this plugin understands (${target}); upgrade the dev-flows plugin`,
      ],
    }
  }
  while (version < target) {
    const step = migrations.find((m) => m.from === version)
    if (!step) {
      return { issues: [`no migration from config version ${version}`] }
    }
    config = { ...step.migrate(structuredClone(config)), version: version + 1 }
    version += 1
  }
  return { config, issues: [] }
}

function checkField(
  field: FieldSpec,
  value: unknown,
  where: string,
): string | undefined {
  const type = field.type ?? "string"
  if (type === "string") {
    if (typeof value !== "string" || value.trim() === "") {
      return `${where} must be a non-empty string`
    }
    return field.pattern && !field.pattern.regex.test(value)
      ? `${where} must be ${field.pattern.hint}`
      : undefined
  }
  if (type === "boolean") {
    return typeof value === "boolean"
      ? undefined
      : `${where} must be true or false`
  }
  if (type === "number[]") {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
    ) {
      return `${where} must be a non-empty list of numbers, 0 or more`
    }
    return value.every((v, i) => i === 0 || v > value[i - 1])
      ? undefined
      : `${where} must list its numbers smallest first, without repeats`
  }
  if (
    !Array.isArray(value) ||
    !value.every((v) => typeof v === "string" && v.trim() !== "")
  ) {
    return `${where} must be a list of non-empty strings`
  }
  const bad = field.pattern
    ? value.find((v) => !field.pattern?.regex.test(v))
    : undefined
  return bad === undefined
    ? undefined
    : `${where} must list only ${field.pattern?.hint} (not \`${bad}\`)`
}

function checkWhole(
  field: FieldSpec,
  value: FieldValue,
  where: string,
): string | undefined {
  const problem = field.check?.(value)
  return problem ? `${where} ${problem}` : undefined
}

const UNKNOWN_NOTE = "kept as is; it may come from a newer plugin"

/** Field problems in one entry (or instance), reported at `where`. */
function checkEntry(
  spec: SectionSpec,
  entry: Record<string, unknown>,
  where: string,
  instance: boolean,
  warnings: string[],
): string[] {
  const issues: string[] = []
  const fields = new Map(spec.fields.map((f) => [f.key, f]))
  for (const [key, fieldValue] of Object.entries(entry)) {
    if (instance && key === INSTANCE_KEY) {
      continue
    }
    if (key === USE_KEY && "provides" in spec) {
      issues.push(...checkUse(spec, fieldValue, `${where}.${key}`))
      continue
    }
    const field = fields.get(key)
    if (!field) {
      warnings.push(`unknown field "${where}.${key}" (${UNKNOWN_NOTE})`)
      continue
    }
    if (field.type === "hook[]") {
      issues.push(...checkHooks(fieldValue, `${where}.${key}`, warnings))
      continue
    }
    const problem =
      checkField(field, fieldValue, `${where}.${key}`) ??
      checkWhole(field, fieldValue as FieldValue, `${where}.${key}`)
    if (problem) {
      issues.push(problem)
    }
  }
  for (const field of spec.fields) {
    if (field.required && entry[field.key] === undefined) {
      issues.push(`${where}.${field.key} is required`)
    }
  }
  return issues
}

/** A configured entry as a list of instances (one, unless it's a list). */
export function instancesOf(entry: unknown): SectionValues[] {
  if (Array.isArray(entry)) {
    return entry.filter(isRecord) as SectionValues[]
  }
  return isRecord(entry) ? [entry as SectionValues] : []
}

export type Check = { issues: string[]; warnings: string[] }

/** Errors that make a (migrated) config unusable, and warnings that don't. */
export function checkConfig(
  config: RawConfig,
  registry: SectionSpec[] = SECTIONS,
): Check {
  const issues: string[] = []
  const warnings: string[] = []
  const known = new Map(registry.map((s) => [s.path, s]))
  const containers = containerPaths(registry)

  const topLevel = new Set(["version", "skipped"])
  for (const path of [...known.keys(), ...containers]) {
    topLevel.add(path.split(".")[0])
  }
  for (const key of Object.keys(config)) {
    if (!topLevel.has(key)) {
      warnings.push(`unknown key "${key}" (${UNKNOWN_NOTE})`)
    }
  }
  for (const container of containers) {
    const value = getAt(config, container)
    if (value === undefined) {
      continue
    }
    if (!isRecord(value)) {
      issues.push(`${container} must be an object`)
      continue
    }
    for (const child of Object.keys(value)) {
      const path = `${container}.${child}`
      if (!known.has(path) && !containers.includes(path)) {
        warnings.push(`unknown section "${path}" (${UNKNOWN_NOTE})`)
      }
    }
  }

  const skipped = config.skipped
  const skippedList: string[] = []
  if (skipped !== undefined) {
    if (
      !Array.isArray(skipped) ||
      !skipped.every((p) => typeof p === "string")
    ) {
      issues.push("skipped must be a list of section paths")
    } else {
      skippedList.push(...skipped)
    }
  }

  for (const spec of registry) {
    const value = getAt(config, spec.path)
    if (value === undefined) {
      if (spec.required) {
        issues.push(`${spec.path} is required`)
      }
      continue
    }
    if (Array.isArray(value)) {
      if (!spec.multiple) {
        issues.push(
          `${spec.path} must be an object (it can't be configured more than once)`,
        )
        continue
      }
      if (value.length === 0) {
        issues.push(`${spec.path} must list at least one instance`)
        continue
      }
    } else if (!isRecord(value)) {
      issues.push(`${spec.path} must be an object`)
      continue
    }
    const list = Array.isArray(value)
    const names = new Set<string>()
    for (const [index, entry] of (list ? value : [value]).entries()) {
      let where = spec.path
      if (list) {
        const name = isRecord(entry) ? entry[INSTANCE_KEY] : undefined
        const valid = typeof name === "string" && INSTANCE_NAME.test(name)
        if (!valid) {
          issues.push(
            `${spec.path}[${index}].${INSTANCE_KEY} must be lowercase letters, digits, ".", "_", or "-"`,
          )
        } else if (names.has(name)) {
          issues.push(`${spec.path} has two instances named "${name}"`)
        } else {
          names.add(name)
        }
        where = valid ? `${spec.path}[${name}]` : `${spec.path}[${index}]`
      }
      if (!isRecord(entry)) {
        issues.push(`${where} must be an object`)
        continue
      }
      issues.push(...checkEntry(spec, entry, where, list, warnings))
    }
  }

  for (const path of skippedList) {
    const spec = known.get(path)
    if (!spec) {
      warnings.push(`skipped lists unknown section "${path}" (${UNKNOWN_NOTE})`)
    } else if (spec.required) {
      issues.push(`${path} is required and can't be skipped`)
    } else if (getAt(config, path) !== undefined) {
      issues.push(`${path} is both configured and skipped`)
    }
  }
  return { issues, warnings }
}

export type ConfigPatch = {
  /** Each section given replaces its whole entry (an object, or a list of named instances); `null` removes it. */
  sections?: Record<string, SectionEntry | null>
  /** Sections to mark as deliberately not configured (removes their entries). */
  skip?: string[]
}

/** Problems with the patch itself: writes may only touch known sections. */
export function checkPatch(
  patch: ConfigPatch,
  registry: SectionSpec[] = SECTIONS,
): string[] {
  const known = new Map(registry.map((s) => [s.path, s]))
  const issues: string[] = []
  const paths = registry.map((s) => s.path).join(", ")
  for (const path of [
    ...Object.keys(patch.sections ?? {}),
    ...(patch.skip ?? []),
  ]) {
    if (!known.has(path)) {
      issues.push(`unknown section "${path}" (known: ${paths})`)
    }
  }
  for (const path of patch.skip ?? []) {
    if (known.get(path)?.required) {
      issues.push(`${path} is required and can't be skipped`)
    }
  }
  return issues
}

/** Keys of `value` with `first` (in that order) ahead of the rest (in theirs). */
function ordered<T>(
  value: Record<string, T>,
  first: string[],
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of first) {
    if (key in value) {
      out[key] = value[key]
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!(key in out)) {
      out[key] = entry
    }
  }
  return out
}

/**
 * Put every known key in registry order (unknown keys after, in their original
 * order), so the same content always serializes to the same bytes.
 */
export function normalize(
  config: RawConfig,
  registry: SectionSpec[] = SECTIONS,
): RawConfig {
  const out = structuredClone(config)
  for (const spec of registry) {
    const value = getAt(out, spec.path)
    const keys = [...spec.fields.map((f) => f.key), USE_KEY]
    if (isRecord(value)) {
      setAt(out, spec.path, ordered(value, keys))
    } else if (Array.isArray(value)) {
      // Instances keep their order: it's the team's, and flows try them in it.
      setAt(
        out,
        spec.path,
        value.map((entry) =>
          isRecord(entry) ? ordered(entry, [INSTANCE_KEY, ...keys]) : entry,
        ),
      )
    }
  }
  // Deepest containers first, so each level sees its children already ordered.
  const containers = containerPaths(registry).sort(
    (a, b) => b.split(".").length - a.split(".").length,
  )
  for (const container of containers) {
    const value = getAt(out, container)
    if (!isRecord(value)) {
      continue
    }
    if (Object.keys(value).length === 0) {
      deleteAt(out, container)
      continue
    }
    const children = [...registry.map((s) => s.path), ...containers]
      .filter((p) => p.startsWith(`${container}.`))
      .map((p) => p.slice(container.length + 1).split(".")[0])
    setAt(out, container, ordered(value, [...new Set(children)]))
  }
  if (Array.isArray(out.skipped)) {
    const order = registry.map((s) => s.path)
    const rank = (p: string) =>
      order.includes(p) ? order.indexOf(p) : order.length
    out.skipped = [...new Set(out.skipped as string[])].sort(
      (a, b) => rank(a) - rank(b),
    )
    if ((out.skipped as string[]).length === 0) {
      delete out.skipped
    }
  }
  const top = ["version", ...new Set(registry.map((s) => s.path.split(".")[0]))]
  const result = ordered(out, top)
  // `skipped` always last, after any unknown keys.
  if ("skipped" in result) {
    const { skipped, ...rest } = result
    return { ...rest, skipped }
  }
  return result
}

/**
 * Apply `patch` to `config`: sections the patch omits (including unknown ones)
 * are kept, configuring a section un-skips it, and the result is normalized,
 * so applying the same patch twice gives byte-identical output.
 */
export function applyPatch(
  config: RawConfig | undefined,
  patch: ConfigPatch,
  registry: SectionSpec[] = SECTIONS,
): RawConfig {
  const out: RawConfig = structuredClone(config ?? {})
  out.version = CONFIG_VERSION
  const skipped = new Set(
    Array.isArray(out.skipped) ? (out.skipped as string[]) : [],
  )
  for (const [path, values] of Object.entries(patch.sections ?? {})) {
    if (values === null) {
      deleteAt(out, path)
    } else {
      setAt(out, path, values)
      skipped.delete(path)
    }
  }
  for (const path of patch.skip ?? []) {
    deleteAt(out, path)
    skipped.add(path)
  }
  out.skipped = [...skipped]
  return normalize(out, registry)
}

export function serializeConfig(config: RawConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * True when two JSON values hold the same config: arrays in the same order,
 * objects with the same keys in any order. A file the repo's formatter laid
 * out, or someone reordered by hand, is the same config as long as this holds.
 */
export function sameConfig(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameConfig(item, b[i]))
    )
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) {
      return false
    }
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && sameConfig(a[k], b[k]))
    )
  }
  return a === b
}

export type PlannedChange =
  | { section: string; kind: "add"; values: SectionEntry; evidence: string[] }
  | {
      section: string
      kind: "fill"
      field: string
      value: FieldValue
      evidence: string[]
    }

export type Plan = {
  /** True when the config exists and nothing new was found: nothing to do. */
  upToDate: boolean
  /** What detection would add: new sections, and empty fields of configured ones. */
  changes: PlannedChange[]
  /** Required fields still missing after the changes, per section (and instance, for a list). */
  needs: { section: string; instance?: string; fields: string[] }[]
  /** Configured values that disagree with detection. Never changed automatically. */
  conflicts: {
    section: string
    field: string
    configured: FieldValue
    detected: FieldValue
  }[]
  /**
   * Instances detected for a configured section that allows several, matching
   * none of its configured ones (a second linked Vercel app). Offered, never
   * added automatically, and they don't make the plan out of date.
   */
  moreInstances: { section: string; instances: SectionValues[] }[]
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Whether a detected instance is a configured one: they share at least one
 * required field (its identity: a project id, a repo), and agree on every
 * required field both set.
 */
function sameInstance(
  spec: SectionSpec,
  configured: SectionValues,
  detected: SectionValues,
): boolean {
  const shared = spec.fields.filter(
    (f) =>
      f.required &&
      configured[f.key] !== undefined &&
      detected[f.key] !== undefined,
  )
  return (
    shared.length > 0 &&
    shared.every((f) => sameValue(configured[f.key], detected[f.key]))
  )
}

function identifiable(spec: SectionSpec, values: SectionValues): boolean {
  return spec.fields.some((f) => f.required && values[f.key] !== undefined)
}

/**
 * Resolve section names as a user types them: a full path (`integrations.linear`)
 * or its last segment (`linear`).
 */
export function resolveSections(
  names: string[],
  registry: SectionSpec[] = SECTIONS,
): { paths: string[]; unknown: string[] } {
  const paths: string[] = []
  const unknown: string[] = []
  for (const name of names) {
    const spec = registry.find(
      (s) => s.path === name || s.path.split(".").at(-1) === name,
    )
    if (!spec) {
      unknown.push(name)
    } else if (!paths.includes(spec.path)) {
      paths.push(spec.path)
    }
  }
  return { paths, unknown }
}

/**
 * What a configure run has left to do. Configured values win over detected
 * ones, skipped sections are never proposed, and required sections are always
 * proposed, so once a run has written the config, the next run with no new
 * evidence plans nothing.
 *
 * With `only`, the plan covers just those section paths, and proposes each of
 * them even when it's skipped or nothing was detected: the user asked for it.
 * Required sections the config still lacks are planned too, since the file
 * isn't valid without them.
 */
export function planConfig(
  config: RawConfig | undefined,
  detected: Record<string, Detection>,
  registry: SectionSpec[] = SECTIONS,
  only?: string[],
): Plan {
  const changes: PlannedChange[] = []
  const conflicts: Plan["conflicts"] = []
  const moreInstances: Plan["moreInstances"] = []
  const skipped = new Set(
    Array.isArray(config?.skipped) ? (config.skipped as string[]) : [],
  )
  const proposed = new Map<string, SectionEntry>()
  const specs = only
    ? registry.filter(
        (spec) =>
          only.includes(spec.path) ||
          (spec.required &&
            !isRecord(config ? getAt(config, spec.path) : undefined)),
      )
    : registry
  for (const spec of specs) {
    const current = config ? getAt(config, spec.path) : undefined
    const found =
      detected[spec.path] ??
      (only?.includes(spec.path)
        ? { values: {}, evidence: ["requested"] }
        : spec.required
          ? { values: {}, evidence: ["always configured"] }
          : undefined)
    if (isRecord(current) || Array.isArray(current)) {
      proposed.set(spec.path, current as SectionEntry)
    }
    if (!found || (!only && skipped.has(spec.path))) {
      continue
    }
    if (!isRecord(current) && !Array.isArray(current)) {
      const values: SectionEntry =
        spec.multiple && (found.instances?.length ?? 0) > 1
          ? (found.instances as SectionValues[])
          : found.values
      changes.push({
        section: spec.path,
        kind: "add",
        values,
        evidence: found.evidence,
      })
      proposed.set(spec.path, values)
      continue
    }
    const compare = (configured: SectionValues, values: SectionValues) => {
      for (const [field, value] of Object.entries(values)) {
        if (field === INSTANCE_KEY) {
          continue
        }
        if (configured[field] === undefined) {
          changes.push({
            section: spec.path,
            kind: "fill",
            field,
            value,
            evidence: found.evidence,
          })
        } else if (!sameValue(configured[field], value)) {
          conflicts.push({
            section: spec.path,
            field,
            configured: configured[field],
            detected: value,
          })
        }
      }
    }
    if (!spec.multiple) {
      compare(current as SectionValues, found.values)
      continue
    }
    // Several can exist, so detected values that differ from the configured
    // ones are another instance, not a conflict. Fill only the instance they
    // match, and never edit a list: the team curated it.
    const configured = instancesOf(current)
    const unmatched: SectionValues[] = []
    // Offered names must be free, so adding them to the list can't collide.
    const taken = new Set(configured.map((c) => String(c[INSTANCE_KEY])))
    for (const instance of found.instances ?? [found.values]) {
      const match = configured.find((c) => sameInstance(spec, c, instance))
      if (match && !Array.isArray(current)) {
        compare(match, instance)
      } else if (!match && identifiable(spec, instance)) {
        const name = instance[INSTANCE_KEY]
        if (typeof name === "string") {
          const free = freeInstanceName(name, taken)
          taken.add(free)
          unmatched.push({ ...instance, [INSTANCE_KEY]: free })
        } else {
          unmatched.push(instance)
        }
      } else if (!match && !found.instances && !Array.isArray(current)) {
        // Nothing to identify an instance by (only optional fields, like a
        // self-hosted URL): it can only describe the one configured.
        compare(current as SectionValues, instance)
      }
    }
    if (unmatched.length > 0) {
      moreInstances.push({ section: spec.path, instances: unmatched })
    }
  }
  const needs: Plan["needs"] = []
  for (const spec of specs) {
    const entry = proposed.get(spec.path)
    if (!entry) {
      continue
    }
    for (const values of instancesOf(entry)) {
      const missing = spec.fields
        .filter((f) => f.required && values[f.key] === undefined)
        .map((f) => f.key)
      // An integration says what the team uses it for; configure asks.
      if ("provides" in spec && values[USE_KEY] === undefined) {
        missing.push(USE_KEY)
      }
      if (missing.length > 0) {
        needs.push({
          section: spec.path,
          ...(Array.isArray(entry)
            ? { instance: String(values[INSTANCE_KEY]) }
            : {}),
          fields: missing,
        })
      }
    }
  }
  return {
    upToDate:
      config !== undefined && changes.length === 0 && needs.length === 0,
    changes,
    needs,
    conflicts,
    moreInstances,
  }
}

/** A config made of every section's example values: what the docs show. */
export function exampleConfig(registry: SectionSpec[] = SECTIONS): RawConfig {
  const out: RawConfig = { version: CONFIG_VERSION }
  for (const spec of registry) {
    setAt(
      out,
      spec.path,
      Object.fromEntries(spec.fields.map((f) => [f.key, f.example])),
    )
  }
  return normalize(out, registry)
}

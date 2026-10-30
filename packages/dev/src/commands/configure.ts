// CLI over the repository's agent-flows config (.agent-flows/config.json).
// Everything section-specific lives in src/config/sections; this file only
// reads, plans, and writes, so every section behaves the same way.

import fs from "node:fs"
import path from "node:path"
import { probeAll, systemProbe } from "../config/access.ts"
import { type LoadedAdapter, loadAdapters } from "../config/adapters/index.ts"
import { CAPABILITIES } from "../config/capabilities.ts"
import {
  applyPatch,
  CONFIG_PATH,
  type ConfigPatch,
  checkConfig,
  checkPatch,
  getAt,
  INSTANCE_KEY,
  isRecord,
  joinOverride,
  migrate,
  OVERRIDE_MODES,
  type OverrideMode,
  overlay,
  planConfig,
  type RawConfig,
  resolveSections,
  sameConfig,
  serializeConfig,
} from "../config/config.ts"
import { createDetectContext, detectSections } from "../config/detect.ts"
import { type FormatResult, formatFile } from "../config/format.ts"
import {
  type HookSuggestion,
  suggestHooks,
} from "../config/hook-suggestions.ts"
import { INSTANCE_NAME } from "../config/instances.ts"
import {
  coverage,
  findCapability,
  providersOf,
  resolveCapability,
} from "../config/integrations.ts"
import {
  checkSource,
  describeSource,
  gitCommonDir,
  localConfigPath,
  readLocal,
  type TokenSource,
  tokenKey,
  writeLocal,
} from "../config/local.ts"
import { INTEGRATIONS, SECTIONS } from "../config/sections/index.ts"
import { isMain, printJson, readStdin, run, runMain } from "./lib.ts"

/** Exit code that tells a flow the repo isn't configured for what it needs. */
export const NOT_CONFIGURED_EXIT = 2

export function repoRoot(cwd = process.cwd()): string {
  const result = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"])
  return result.status === 0 ? result.stdout.trim() : cwd
}

export type Loaded = {
  configPath: string
  /** True when the committed file or this machine's override exists. */
  exists: boolean
  /** This machine's override, when there is one. */
  localPath?: string
  /**
   * How the override applies: `merge` lays it over the committed file,
   * `replace` uses it alone.
   */
  override?: OverrideMode
  /** Merged: section paths the override sets or skips, over the committed file. */
  overridden?: string[]
  /** Present when the config is usable (migrated to the current version). */
  config?: RawConfig
  /**
   * The config migrated to the current version, valid or not: the committed
   * file, with the override applied when there is one. Missing when a file
   * can't be read as a config at all.
   */
  draft?: RawConfig
  issues: string[]
  warnings: string[]
}

type ConfigFile = {
  exists: boolean
  /** The file migrated to the current version, valid or not. */
  draft?: RawConfig
  /** Why it can't be read as a config at all (bad JSON, a newer version). */
  issues: string[]
}

function readConfigFile(file: string): ConfigFile {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return { exists: false, issues: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      exists: true,
      issues: [
        `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }
  if (!isRecord(parsed)) {
    return { exists: true, issues: ["config must be a JSON object"] }
  }
  const migrated = migrate(parsed)
  return migrated.config
    ? { exists: true, draft: migrated.config, issues: [] }
    : { exists: true, issues: migrated.issues }
}

/** Where this machine's override is, or undefined outside a git repo. */
function localConfigFile(root: string): string | undefined {
  const dir = gitCommonDir(root)
  return dir ? localConfigPath(dir) : undefined
}

/**
 * The config flows use: the committed file, with this machine's override
 * merged over it or replacing it when there is one, so a repo that isn't
 * yours can be configured for you alone.
 */
export function loadConfig(root: string): Loaded {
  const configPath = path.join(root, CONFIG_PATH)
  const shared = readConfigFile(configPath)
  const localPath = localConfigFile(root)
  const local: ConfigFile = localPath
    ? readConfigFile(localPath)
    : { exists: false, issues: [] }
  const base = {
    configPath,
    exists: shared.exists || local.exists,
    ...(local.exists ? { localPath } : {}),
  }
  const unreadable = [
    ...shared.issues,
    ...local.issues.map((issue) => `${localPath}: ${issue}`),
  ]
  if (unreadable.length > 0) {
    return { ...base, issues: unreadable, warnings: [] }
  }
  if (!local.draft) {
    if (!shared.draft) {
      return { ...base, issues: [], warnings: [] }
    }
    const { issues, warnings } = checkConfig(shared.draft)
    return {
      ...base,
      draft: shared.draft,
      ...(issues.length === 0 ? { config: shared.draft } : {}),
      issues,
      warnings,
    }
  }
  const applied = overlay(shared.draft, local.draft)
  const draft = applied.config
  const checked = checkConfig(draft)
  const issues = [
    ...applied.issues.map((issue) => `${localPath}: ${issue}`),
    ...checked.issues,
  ]
  // Replaced, the override's own warnings are the config's.
  const warnings =
    applied.mode === "replace"
      ? checked.warnings
      : [
          ...checked.warnings,
          ...checkConfig(applied.own).warnings.map((w) => `${localPath}: ${w}`),
        ]
  return {
    ...base,
    override: applied.mode,
    ...(applied.mode === "merge" ? { overridden: applied.overridden } : {}),
    draft,
    ...(issues.length === 0 ? { config: draft } : {}),
    issues,
    warnings,
  }
}

/** Every path `get` accepts: containers, sections, and their fields. */
export function knownPaths(): Set<string> {
  const out = new Set<string>()
  for (const spec of SECTIONS) {
    const parts = spec.path.split(".")
    for (let i = 1; i <= parts.length; i++) {
      out.add(parts.slice(0, i).join("."))
    }
    for (const field of spec.fields) {
      out.add(`${spec.path}.${field.key}`)
    }
  }
  return out
}

function notConfigured(
  details: Record<string, unknown>,
  message: string,
): void {
  printJson({ configured: false, ...details, message })
  process.exitCode = NOT_CONFIGURED_EXIT
}

/** The config, or `"configured": false` (exit 2) when it's missing or invalid. */
function requireConfig(root: string): RawConfig | undefined {
  const loaded = loadConfig(root)
  if (!loaded.config) {
    notConfigured(
      {
        configPath: loaded.configPath,
        ...(loaded.exists ? { issues: loaded.issues } : {}),
      },
      loaded.exists
        ? `${CONFIG_PATH} is invalid. Run the dev-flows configure command to fix it.`
        : `This repo has no ${CONFIG_PATH} yet. Run the dev-flows configure command first.`,
    )
    return undefined
  }
  return loaded.config
}

/**
 * Print the values at `paths`, or `"configured": false` and exit 2 when the
 * config is missing, invalid, or lacks any of them. Flows read configuration
 * only through this, so they all fail the same way: by sending the user to
 * configure instead of guessing.
 */
function get(root: string, args: string[]): void {
  // Optional settings read as null when unset, rather than stopping the flow.
  const optional = args.includes("--optional")
  const paths = args.filter((a) => a !== "--optional")
  if (paths.length === 0) {
    throw new Error("get needs at least one path, e.g. `get repo.baseBranch`")
  }
  const known = knownPaths()
  const unknown = paths.filter((p) => !known.has(p))
  if (unknown.length > 0) {
    throw new Error(
      `unknown config path(s): ${unknown.join(", ")} (known: ${[...known].join(", ")})`,
    )
  }
  const config = requireConfig(root)
  if (!config) {
    return
  }
  const skipped = Array.isArray(config.skipped)
    ? (config.skipped as string[])
    : []
  const missing = paths.filter((p) => readPath(config, p) === undefined)
  if (missing.length > 0 && !optional) {
    notConfigured(
      {
        configPath: path.join(root, CONFIG_PATH),
        missing: missing.map((p) => ({
          path: p,
          ...(skipped.some((s) => p === s || p.startsWith(`${s}.`))
            ? { skipped: true }
            : {}),
        })),
      },
      `${CONFIG_PATH} doesn't set ${missing.join(", ")}. Run the dev-flows configure command to add it.`,
    )
    return
  }
  printJson({
    values: Object.fromEntries(
      paths.map((p) => [p, readPath(config, p) ?? null]),
    ),
  })
}

/**
 * The value at `path`. A field of a section configured as a list reads as
 * `[{"name": ..., "value": ...}]`, one per instance, with `null` for an
 * instance that doesn't set it; missing only when none does.
 */
function readPath(config: RawConfig, path: string): unknown {
  const spec = SECTIONS.find((s) => path.startsWith(`${s.path}.`))
  const entry = spec ? getAt(config, spec.path) : undefined
  if (!spec || !Array.isArray(entry)) {
    return getAt(config, path)
  }
  const key = path.slice(spec.path.length + 1)
  const instances = entry.filter(isRecord)
  return instances.some((e) => e[key] !== undefined)
    ? instances.map((e) => ({ name: e[INSTANCE_KEY], value: e[key] ?? null }))
    : undefined
}

/**
 * Print every configured integration for each capability, with its values and
 * ops. A capability with none is `"configured": false` (exit 2) unless
 * `--optional`, where the flow can carry on without it and gets an empty list.
 */
async function integrations(root: string, args: string[]): Promise<void> {
  const optional = args.includes("--optional")
  const names = args.filter((a) => a !== "--optional")
  if (names.length === 0) {
    throw new Error(
      "integrations needs at least one capability, e.g. `integrations sourceControl`",
    )
  }
  const unknown = names.filter((n) => !findCapability(n))
  if (unknown.length > 0) {
    throw new Error(
      `unknown capability(s): ${unknown.join(", ")} (known: ${CAPABILITIES.map((c) => c.id).join(", ")})`,
    )
  }
  const config = requireConfig(root)
  if (!config) {
    return
  }
  // Probe only what's configured for the capabilities asked about.
  const ids = names.map((name) => (findCapability(name) as { id: string }).id)
  const configured = INTEGRATIONS.filter(
    (spec) =>
      getAt(config, spec.path) !== undefined &&
      ids.some((id) => id in spec.provides),
  )
  const access = await probeAll(
    configured,
    systemProbe(),
    readLocal(root).tokens,
  )
  const scripts: Record<string, Record<string, LoadedAdapter>> = {}
  const adapterIssues: string[] = []
  for (const spec of configured) {
    const loaded = await loadAdapters(root, spec)
    scripts[spec.path] = loaded.adapters
    adapterIssues.push(...loaded.issues)
  }
  const resolved = ids.map(
    (id) =>
      [
        id,
        resolveCapability(config, id, INTEGRATIONS, access, scripts),
      ] as const,
  )
  const missing = resolved.filter(([, r]) => r.configured.length === 0)
  if (!optional && missing.length > 0) {
    notConfigured(
      {
        configPath: path.join(root, CONFIG_PATH),
        missing: missing.map(([capability, r]) => ({
          capability,
          ...(r.unconfigured.length > 0 ? { options: r.unconfigured } : {}),
          ...(r.skipped.length > 0 ? { skipped: r.skipped } : {}),
        })),
      },
      `${CONFIG_PATH} has no integration for ${missing.map(([c]) => c).join(", ")}. Run the dev-flows configure command with that capability to add one.`,
    )
    return
  }
  printJson({
    integrations: Object.fromEntries(
      resolved.map(([id, r]) => [id, r.configured]),
    ),
    // A broken adapter file costs only its adapters; the ops still have the
    // other variants.
    ...(adapterIssues.length > 0 ? { warnings: adapterIssues } : {}),
  })
}

/**
 * Record where an integration's API token is on this machine, in the repo's
 * git dir: never the token, and never in the committed config.
 */
function token(root: string, args: string[]): void {
  const [target, kind, value] = args
  // `linear:<instance>`: a token for one instance, over the integration's.
  const [name, instance] = (target ?? "").split(":")
  const spec = INTEGRATIONS.find(
    (s) => s.path === `integrations.${name}` || s.path === name,
  )
  if (!spec?.access.api) {
    throw new Error(
      `token needs an integration with an API: ${INTEGRATIONS.filter(
        (s) => s.access.api,
      )
        .map((s) => s.path.split(".").at(-1))
        .join(", ")}`,
    )
  }
  if (instance !== undefined && !INSTANCE_NAME.test(instance)) {
    throw new Error(
      `\`${instance}\` isn't an instance name: lowercase letters, digits, ".", "_", or "-"`,
    )
  }
  const id = tokenKey(spec.path.split(".").at(-1) as string, instance)
  const local = readLocal(root)
  if (kind === "--clear") {
    delete local.tokens[id]
    writeLocal(root, local)
    printJson({ written: true, integration: id, source: null })
    return
  }
  let source: TokenSource
  if (kind === "--env" && value) {
    source = { env: value }
  } else if (kind === "--file" && value) {
    source = {
      file: path.resolve(value.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")),
    }
  } else if (kind === "--command" && value) {
    source = { command: value }
  } else {
    throw new Error(
      "token <integration>[:<instance>] --env <NAME> | --file <path> | --command <command> | --clear",
    )
  }
  const issues = checkSource(source)
  if (issues.length > 0) {
    printJson({ written: false, issues })
    process.exitCode = 1
    return
  }
  local.tokens[id] = source
  const file = writeLocal(root, local)
  printJson({
    written: true,
    integration: id,
    source: describeSource(source),
    file,
  })
}

/**
 * Section paths for what a user typed: a section path, its last segment, or a
 * capability (every integration that provides it).
 */
export function resolveNames(names: string[]): {
  paths: string[]
  unknown: string[]
} {
  const paths: string[] = []
  const rest: string[] = []
  for (const name of names) {
    const capability = findCapability(name)
    if (capability) {
      paths.push(...providersOf(capability.id).map((s) => s.path))
    } else {
      rest.push(name)
    }
  }
  const sections = resolveSections(rest)
  return {
    paths: [...new Set([...paths, ...sections.paths])],
    unknown: sections.unknown,
  }
}

/** How a configure run goes: decide what it can, or walk every section. */
export const MODES = ["auto", "manual"] as const
export type Mode = (typeof MODES)[number]

/** The word that sends a run's writes to this machine's override. */
export const LOCAL = "local"
/** The word for an override that replaces the committed config (implies local). */
export const REPLACE = "replace"

/**
 * The mode a user typed, if any, whether they asked for `local` (writes go to
 * this machine's override) or `replace` (the override replaces the committed
 * config), and the section names after it. Names alone mean a manual walk of
 * just those sections.
 */
export function parseMode(args: string[]): {
  mode?: Mode
  local?: true
  replace?: true
  names: string[]
} {
  const named = args.filter((a): a is Mode => MODES.includes(a as Mode))
  if (named.length > 1) {
    throw new Error(`pick one mode, not ${named.join(" and ")}`)
  }
  const names = args.filter(
    (a) => !MODES.includes(a as Mode) && a !== LOCAL && a !== REPLACE,
  )
  const replace = args.includes(REPLACE)
  const mode = named[0] ?? (names.length > 0 ? "manual" : undefined)
  return {
    ...(mode ? { mode } : {}),
    ...(replace || args.includes(LOCAL) ? { local: true as const } : {}),
    ...(replace ? { replace: true as const } : {}),
    names,
  }
}

const PATCH_SHAPE =
  '{"sections": {"<path>": {...} | [{"name": ..., ...}, ...] | null}, "skip": ["<path>", ...]}'

/** The patch on stdin; `optional` reads no input (or `{}`) as no changes. */
function parsePatch(input: string, optional = false): ConfigPatch {
  if (optional && !input.trim()) {
    return {}
  }
  let patch: unknown
  try {
    patch = JSON.parse(input)
  } catch {
    throw new Error(`write expects JSON on stdin: ${PATCH_SHAPE}`)
  }
  if (!isRecord(patch)) {
    throw new Error(`write expects ${PATCH_SHAPE}`)
  }
  const { sections, skip } = patch
  const sectionsOk =
    sections === undefined ||
    (isRecord(sections) &&
      Object.values(sections).every(
        (v) =>
          v === null || isRecord(v) || (Array.isArray(v) && v.every(isRecord)),
      ))
  const skipOk =
    skip === undefined ||
    (Array.isArray(skip) && skip.every((p) => typeof p === "string"))
  const extra = Object.keys(patch).filter(
    (k) => k !== "sections" && k !== "skip",
  )
  if (
    !sectionsOk ||
    !skipOk ||
    extra.length > 0 ||
    (!sections && !skip && !optional)
  ) {
    throw new Error(`write expects ${PATCH_SHAPE}`)
  }
  return patch as ConfigPatch
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * Write the config, then lay it out with the repo's formatter. A formatter
 * that changed what the file holds is undone: the file must stay this config.
 */
function writeFormatted(
  root: string,
  configPath: string,
  config: RawConfig,
): FormatResult {
  const content = serializeConfig(config)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, content)
  const result = formatFile(root, path.relative(root, configPath))
  if (result.formatted && !sameConfig(readJson(configPath), config)) {
    fs.writeFileSync(configPath, content)
    return {
      formatted: false,
      reason: `${result.formatted} changed the config's content`,
    }
  }
  return result
}

/**
 * Patch the committed config, or with `local`, this machine's override of it,
 * switching the override to `mode` when given. The committed file must be
 * valid on its own, since the team shares it; the override must make a valid
 * config once applied.
 */
async function write(
  root: string,
  local?: { mode?: OverrideMode },
): Promise<void> {
  const patch = parsePatch(await readStdin(), Boolean(local?.mode))
  const sharedPath = path.join(root, CONFIG_PATH)
  const configPath = local ? localConfigFile(root) : sharedPath
  if (!configPath) {
    throw new Error("write --local needs a git repository")
  }
  const current = readConfigFile(configPath)
  // An invalid file is patched as it stands, so a write can repair it; the
  // result must be valid, like any write. Only a file that isn't a config at
  // all (bad JSON, a newer version) has to be fixed by hand.
  if (current.exists && !current.draft) {
    throw new Error(
      `${configPath} can't be read; fix it by hand:\n- ${current.issues.join("\n- ")}`,
    )
  }
  const patchIssues = checkPatch(patch)
  if (patchIssues.length > 0) {
    printJson({ configPath, written: false, issues: patchIssues })
    process.exitCode = 1
    return
  }
  let next: RawConfig
  let effective: RawConfig
  if (local) {
    const shared = readConfigFile(sharedPath)
    if (shared.exists && !shared.draft) {
      throw new Error(
        `${CONFIG_PATH} can't be read; fix it by hand:\n- ${shared.issues.join("\n- ")}`,
      )
    }
    const applied = current.draft
      ? overlay(shared.draft, current.draft)
      : undefined
    const mode = local.mode ?? applied?.mode ?? "merge"
    // Switching to replace starts from the config as it reads now, so the
    // override begins as a copy of what it stops following.
    const base =
      mode === "replace" && applied?.mode !== "replace"
        ? (applied?.config ?? shared.draft)
        : applied?.own
    next = joinOverride(mode, applyPatch(base, patch))
    effective = overlay(shared.draft, next).config
  } else {
    next = applyPatch(current.draft, patch)
    effective = next
  }
  const { issues, warnings } = checkConfig(effective)
  if (issues.length > 0) {
    printJson({ configPath, written: false, issues })
    process.exitCode = 1
    return
  }
  // Leave the file alone when its content is the same, however it's laid out,
  // so re-running is a no-op.
  const changed = !sameConfig(readJson(configPath), next)
  let format: FormatResult | undefined
  if (changed && local) {
    // The override is in the git dir, out of the repo formatter's reach.
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, serializeConfig(next))
  } else if (changed) {
    format = writeFormatted(root, configPath, next)
  }
  printJson({
    configPath,
    ...(local ? { local: true } : {}),
    written: changed,
    ...(format
      ? {
          formatted: format.formatted,
          ...(format.formatted === false
            ? { formatReason: format.reason }
            : {}),
        }
      : {}),
    config: next,
    coverage: coverage(effective),
    ...(warnings.length > 0 ? { warnings } : {}),
  })
}

const HELP = `Usage: configure.ts <command>

  show            Print the config with its issues and warnings: ${CONFIG_PATH},
                  with this machine's override (localPath) applied when there
                  is one: how it applies (override: merge or replace), and,
                  merged, the sections it overrides.
  detect [auto | manual] [local | replace] [section | capability ...]
                  Print the current config, what each section's detector found
                  (values and evidence), and a plan: what's new, which required
                  fields are missing, and whether it's already upToDate. Given
                  sections (linear or integrations.linear) or capabilities
                  (issueTracker: every integration providing it), detects and
                  plans only those, including ones skipped before. manual with
                  no names plans every section the same way. Prints the mode
                  (names alone mean manual; none at all, no mode), and
                  "local": true when local or replace was given, so the run
                  writes with --local ("replace": true: --local --replace).
  get <path>... [--optional]
                  Print {"values": {"<path>": value}} for sections or fields
                  (repo.baseBranch, integrations.linear). A field of an
                  integration configured as a list prints one {name, value}
                  per instance. Exits ${NOT_CONFIGURED_EXIT} with
                  {"configured": false} when the config is missing, invalid, or
                  doesn't set a path; with --optional, a path it doesn't set
                  prints null instead.
  token <integration>[:<instance>] --env <NAME> | --file <path> | --command <cmd> | --clear
                  Record where the integration's API token is on this machine
                  (with :<instance>, one instance's own token, for an
                  integration configured more than once on separate accounts)
                  (an env variable, a file holding it, or a command printing
                  it), in the repo's git dir: shared by its worktrees, never
                  committed. Never the token itself. Flows and adapters read
                  the token from there.
  integrations <capability>... [--optional]
                  Print {"integrations": {"<capability>": [...]}}: every
                  configured integration providing it (one per instance), with
                  its values and ops.
                  Exits ${NOT_CONFIGURED_EXIT} with {"configured": false} when the config is
                  missing or invalid, or (without --optional) a capability has
                  no integration.
  write [--local [--merge | --replace]]
                  Read ${PATCH_SHAPE}
                  on stdin. Each section given replaces its entry (a list of
                  named instances, for an integration configured more than
                  once), null removes it, skip marks sections as deliberately
                  not configured.
                  Validates, and writes only if the content changed (layout
                  and key order don't count), then formats the file with the
                  repo's installed Biome or Prettier, if any ("formatted",
                  and "formatReason" when it couldn't). On issues,
                  prints them and exits 1. An invalid file is patched as it
                  stands, so a write that fixes it goes through; one that
                  isn't a config at all (bad JSON, a newer version) has to be
                  fixed by hand.
                  With --local, patches this machine's override instead, in
                  the repo's git dir (shared by its worktrees, never
                  committed): for a repo whose config isn't yours to change.
                  Each section it sets replaces the committed one, its skip
                  list drops committed ones, and null removes a section from
                  the override so the committed one applies again. The
                  override must make a valid config once applied, and isn't
                  formatted (it's outside the repo).
                  --replace makes the override the whole config, ignoring
                  ${CONFIG_PATH}; switching to it starts from the config as it
                  reads now. --merge goes back to layering it over the
                  committed file. Either one persists in the file ("override")
                  and takes an empty patch to just switch.
`

/** Suggestions whose command isn't already a hook at that point. */
export function newHookSuggestions(
  suggestions: HookSuggestion[],
  config: RawConfig | undefined,
): HookSuggestion[] {
  return suggestions.filter(({ point, hook }) => {
    const list = config ? getAt(config, point) : undefined
    return !(
      Array.isArray(list) &&
      list.some(
        (h) => isRecord(h) && (h.run === hook.run || h.name === hook.name),
      )
    )
  })
}

async function main(): Promise<void> {
  const [command = "show", ...args] = process.argv.slice(2)
  const root = repoRoot()
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP)
    return
  }
  if (command === "show") {
    const loaded = loadConfig(root)
    printJson({
      ...loaded,
      ...(loaded.config ? { coverage: coverage(loaded.config) } : {}),
    })
    return
  }
  if (command === "detect") {
    const { mode, local, replace, names } = parseMode(args)
    const { paths, unknown } = resolveNames(names)
    if (unknown.length > 0) {
      throw new Error(
        `unknown section(s): ${unknown.join(", ")} (known sections: ${SECTIONS.map((s) => s.path).join(", ")}; capabilities: ${CAPABILITIES.map((c) => c.id).join(", ")}; modes: ${MODES.join(", ")})`,
      )
    }
    // Manual walks every section, skipped ones included, so with no names it
    // plans them all the way naming each one would.
    const only =
      paths.length > 0
        ? paths
        : mode === "manual"
          ? SECTIONS.map((s) => s.path)
          : undefined
    const loaded = loadConfig(root)
    const context = createDetectContext(root)
    const detected = detectSections(
      context,
      only
        ? SECTIONS.filter((s) => only.includes(s.path) || s.required)
        : SECTIONS,
    )
    printJson({
      mode,
      ...(local ? { local } : {}),
      ...(replace ? { replace } : {}),
      ...loaded,
      ...(only ? { requested: only } : {}),
      ...(loaded.config ? { coverage: coverage(loaded.config) } : {}),
      detected,
      // How this machine can reach each integration, configured or not, so
      // configure can offer the ones that are already within reach.
      access: await probeAll(
        only ? INTEGRATIONS.filter((s) => only.includes(s.path)) : INTEGRATIONS,
        systemProbe(),
        readLocal(root).tokens,
      ),
      // Offered in the hooks walk, never planned: a guessed command is
      // written only after the user takes it and it's been tried.
      hookSuggestions: newHookSuggestions(suggestHooks(context), loaded.draft),
      // A broken file has to be fixed first, so there is no plan.
      ...(loaded.exists && !loaded.config
        ? {}
        : { plan: planConfig(loaded.config, detected, SECTIONS, only) }),
    })
    return
  }
  if (command === "get") {
    get(root, args)
    return
  }
  if (command === "integrations") {
    await integrations(root, args)
    return
  }
  if (command === "token") {
    token(root, args)
    return
  }
  if (command === "write") {
    const flags = OVERRIDE_MODES.map((m) => `--${m}`)
    const modes = args.filter((a) => flags.includes(a))
    const unknown = args.filter((a) => a !== "--local" && !flags.includes(a))
    if (unknown.length > 0 || modes.length > 1) {
      throw new Error(
        `write takes --local, optionally with ${flags.join(" or ")}, not ${args.join(" ")}`,
      )
    }
    if (modes.length > 0 && !args.includes("--local")) {
      throw new Error(`${modes[0]} applies only to write --local`)
    }
    const mode = modes[0]?.slice(2) as OverrideMode | undefined
    await write(
      root,
      args.includes("--local") ? (mode ? { mode } : {}) : undefined,
    )
    return
  }
  throw new Error(
    `Unknown command '${command}'. Use show, detect, get, integrations, or write.`,
  )
}

if (isMain(import.meta.filename)) {
  runMain(main)
}

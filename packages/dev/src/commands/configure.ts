// CLI over the repository's agent-flows config (.agent-flows/config.json).
// Everything section-specific lives in src/config/sections; this file only
// reads, plans, and writes, so every section behaves the same way.

import fs from "node:fs"
import path from "node:path"
import {
  applyPatch,
  CONFIG_PATH,
  type ConfigPatch,
  checkConfig,
  checkPatch,
  getAt,
  isRecord,
  migrate,
  planConfig,
  type RawConfig,
  resolveSections,
  serializeConfig,
} from "../config/config.ts"
import { createDetectContext, detectSections } from "../config/detect.ts"
import { SECTIONS } from "../config/sections/index.ts"
import { isMain, printJson, readStdin, run, runMain } from "./lib.ts"

/** Exit code that tells a flow the repo isn't configured for what it needs. */
export const NOT_CONFIGURED_EXIT = 2

export function repoRoot(cwd = process.cwd()): string {
  const result = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"])
  return result.status === 0 ? result.stdout.trim() : cwd
}

export type Loaded = {
  configPath: string
  exists: boolean
  /** Present when the file is usable (migrated to the current version). */
  config?: RawConfig
  issues: string[]
  warnings: string[]
}

export function loadConfig(root: string): Loaded {
  const configPath = path.join(root, CONFIG_PATH)
  let text: string
  try {
    text = fs.readFileSync(configPath, "utf8")
  } catch {
    return { configPath, exists: false, issues: [], warnings: [] }
  }
  const fail = (issues: string[]): Loaded => ({
    configPath,
    exists: true,
    issues,
    warnings: [],
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return fail([
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ])
  }
  if (!isRecord(parsed)) {
    return fail(["config must be a JSON object"])
  }
  const migrated = migrate(parsed)
  if (!migrated.config) {
    return fail(migrated.issues)
  }
  const { issues, warnings } = checkConfig(migrated.config)
  return {
    configPath,
    exists: true,
    ...(issues.length === 0 ? { config: migrated.config } : {}),
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

/**
 * Print the values at `paths`, or `"configured": false` and exit 2 when the
 * config is missing, invalid, or lacks any of them. Flows read configuration
 * only through this, so they all fail the same way: by sending the user to
 * configure instead of guessing.
 */
function get(root: string, paths: string[]): void {
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
  const loaded = loadConfig(root)
  if (!loaded.config) {
    notConfigured(
      {
        configPath: loaded.configPath,
        ...(loaded.exists ? { issues: loaded.issues } : {}),
      },
      loaded.exists
        ? `${CONFIG_PATH} is invalid. Run the agent-flows configure command to fix it.`
        : `This repo has no ${CONFIG_PATH} yet. Run the agent-flows configure command first.`,
    )
    return
  }
  const config = loaded.config
  const skipped = Array.isArray(config.skipped)
    ? (config.skipped as string[])
    : []
  const missing = paths.filter((p) => getAt(config, p) === undefined)
  if (missing.length > 0) {
    notConfigured(
      {
        configPath: loaded.configPath,
        missing: missing.map((p) => ({
          path: p,
          ...(skipped.some((s) => p === s || p.startsWith(`${s}.`))
            ? { skipped: true }
            : {}),
        })),
      },
      `${CONFIG_PATH} doesn't set ${missing.join(", ")}. Run the agent-flows configure command to add it.`,
    )
    return
  }
  printJson({
    values: Object.fromEntries(paths.map((p) => [p, getAt(config, p)])),
  })
}

const PATCH_SHAPE =
  '{"sections": {"<path>": {...} | null}, "skip": ["<path>", ...]}'

function parsePatch(input: string): ConfigPatch {
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
      Object.values(sections).every((v) => v === null || isRecord(v)))
  const skipOk =
    skip === undefined ||
    (Array.isArray(skip) && skip.every((p) => typeof p === "string"))
  const extra = Object.keys(patch).filter(
    (k) => k !== "sections" && k !== "skip",
  )
  if (!sectionsOk || !skipOk || extra.length > 0 || (!sections && !skip)) {
    throw new Error(`write expects ${PATCH_SHAPE}`)
  }
  return patch as ConfigPatch
}

async function write(root: string): Promise<void> {
  const patch = parsePatch(await readStdin())
  const current = loadConfig(root)
  if (current.exists && !current.config) {
    throw new Error(
      `${CONFIG_PATH} is invalid; fix it first:\n- ${current.issues.join("\n- ")}`,
    )
  }
  const patchIssues = checkPatch(patch)
  if (patchIssues.length > 0) {
    printJson({
      configPath: current.configPath,
      written: false,
      issues: patchIssues,
    })
    process.exitCode = 1
    return
  }
  const next = applyPatch(current.config, patch)
  const { issues, warnings } = checkConfig(next)
  if (issues.length > 0) {
    printJson({ configPath: current.configPath, written: false, issues })
    process.exitCode = 1
    return
  }
  // Leave the file alone when nothing changed, so re-running is a no-op.
  const content = serializeConfig(next)
  let existing: string | undefined
  try {
    existing = fs.readFileSync(current.configPath, "utf8")
  } catch {
    existing = undefined
  }
  const changed = existing !== content
  if (changed) {
    fs.mkdirSync(path.dirname(current.configPath), { recursive: true })
    fs.writeFileSync(current.configPath, content)
  }
  printJson({
    configPath: current.configPath,
    written: changed,
    config: next,
    ...(warnings.length > 0 ? { warnings } : {}),
  })
}

const HELP = `Usage: configure.ts <command>

  show            Print ${CONFIG_PATH} with its issues and warnings.
  detect [section...]
                  Print the current config, what each section's detector found
                  (values and evidence), and a plan: what's new, which required
                  fields are missing, and whether it's already upToDate. Given
                  sections (linear or services.linear), detects and plans only
                  those, including ones skipped before.
  get <path>...   Print {"values": {"<path>": value}} for sections or fields
                  (repo.baseBranch, services.linear). Exits ${NOT_CONFIGURED_EXIT} with
                  {"configured": false} when the config is missing, invalid, or
                  doesn't set a path.
  write           Read ${PATCH_SHAPE}
                  on stdin. Each section given replaces its entry, null removes
                  it, skip marks sections as deliberately not configured.
                  Validates, and writes only if the content changed; on issues,
                  prints them and exits 1.
`

async function main(): Promise<void> {
  const [command = "show", ...args] = process.argv.slice(2)
  const root = repoRoot()
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP)
    return
  }
  if (command === "show") {
    printJson(loadConfig(root))
    return
  }
  if (command === "detect") {
    const { paths, unknown } = resolveSections(args)
    if (unknown.length > 0) {
      throw new Error(
        `unknown section(s): ${unknown.join(", ")} (known: ${SECTIONS.map((s) => s.path).join(", ")})`,
      )
    }
    const only = paths.length > 0 ? paths : undefined
    const loaded = loadConfig(root)
    const detected = detectSections(
      createDetectContext(root),
      only
        ? SECTIONS.filter((s) => only.includes(s.path) || s.required)
        : SECTIONS,
    )
    printJson({
      ...loaded,
      ...(only ? { requested: only } : {}),
      detected,
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
  if (command === "write") {
    await write(root)
    return
  }
  throw new Error(
    `Unknown command '${command}'. Use show, detect, get, or write.`,
  )
}

if (isMain(import.meta.filename)) {
  runMain(main)
}

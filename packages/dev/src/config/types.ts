// The shape every piece of agent-flows configuration is declared in. A section
// (`repo`, `services.github`, …) is one object of fields at a dotted path in
// .agent-flows/config.json. Adding configuration means adding a SectionSpec;
// validation, detection, planning, reads, and the configure skill's docs are
// all derived from the registry, so every section behaves the same way.
//
// Runtime code: commands import this straight from the installed plugin, so it
// uses Node built-ins only.

export type FieldType = "string" | "boolean" | "string[]"

export type FieldValue = string | boolean | string[]

export type FieldSpec = {
  key: string
  description: string
  /** Defaults to "string". */
  type?: FieldType
  example: FieldValue
  required?: boolean
}

export type SectionValues = Record<string, FieldValue>

export type Detection = {
  /** Guessed field values; may be partial or empty. */
  values: SectionValues
  /** Why we think the repo uses this, one short phrase per clue. */
  evidence: string[]
}

/** Read-only view of the checkout that detectors share. */
export type DetectContext = {
  root: string
  /** `git -C root …` stdout (trimmed), or undefined on failure. */
  git(args: string[]): string | undefined
  /** Absolute path of the git common dir (shared by all worktrees). */
  gitCommonDir: string | undefined
  /** Tracked files, repo-relative. */
  tracked: string[]
  /** A file's text, repo-relative or absolute; undefined if unreadable. */
  read(file: string): string | undefined
  /** A file parsed as a JSON object; undefined if missing or not an object. */
  readJson(file: string): Record<string, unknown> | undefined
  /** Directories holding a tracked package.json, plus the root (""). */
  packageDirs: string[]
  /**
   * Evidence lines ("apps/web/package.json depends on @sentry/nextjs") for
   * every JS or Python dependency whose name matches.
   */
  dependsOn(pattern: RegExp): string[]
  /** Committed env templates (.env.example and friends). Real .env files are never read. */
  envTemplates: { file: string; text: string }[]
}

export type SectionSpec = {
  /** Dotted location in the config file: `repo`, `services.github`. */
  path: string
  name: string
  /** What dev flows use it for. */
  purpose: string
  fields: FieldSpec[]
  /**
   * Always configured: configure proposes it even with no evidence, and it
   * can't be skipped. For settings every flow can rely on.
   */
  required?: boolean
  /** How to look values up when detection can't (MCP tools, CLI commands). */
  lookup?: string
  /** Guess values from the checkout. Return undefined when there's no sign of it. */
  detect?(ctx: DetectContext): Detection | undefined
}

/**
 * Upgrades a config from `from` to `from + 1`. Every format change ships one,
 * so older committed configs keep working.
 */
export type Migration = {
  from: number
  migrate(config: Record<string, unknown>): Record<string, unknown>
}

// The shape every piece of agent-flows configuration is declared in. A section
// (`repo`, `integrations.github`, …) is one object of fields at a dotted path in
// .agent-flows/config.json. Adding configuration means adding a SectionSpec;
// validation, detection, planning, reads, and the configure skill's docs are
// all derived from the registry, so every section behaves the same way.
//
// Most sections are integrations: a third-party tool that fills one or more
// capabilities (source control, issue tracker, …). Flows ask for a capability,
// never a vendor, so a repo can swap Linear for Jira, or use both.
//
// Runtime code: commands import this straight from the installed plugin, so it
// uses Node built-ins only.

export type FieldType =
  | "string"
  | "boolean"
  | "string[]"
  | "number[]"
  | "hook[]"

/**
 * A repo's own step at a named point in a flow (`ready.before`), for work no
 * integration covers. It's a command (`run`) whose result the flow acts on,
 * or a `prompt` the agent acts on at that point. `paths`, `modes`, and `on`
 * narrow when it applies. The points and their rules are in `hooks.ts`.
 *
 * A command runs from the repo root, with the point's values in its
 * environment (`AGENT_FLOWS_BASE` and friends) and as `{base}`-style
 * placeholders. Exit 0 passes. Exit 2 hands its stderr to the agent as a task,
 * for a check that found something only judgment can fix. Any other exit, or
 * running past `timeout`, fails: with a `fix`, the flow runs it once and the
 * command again. A prompt is a task too. Either way, the agent works under the
 * command's own rules for what it may change.
 */
export type Hook = {
  /** Shown in progress and the report; unique at its point. */
  name: string
  /** Globs, repo-relative: `*` within a directory, `**` across them. Only when the branch changed a match. */
  paths?: string[]
  /** Only in these modes of the point's flow. */
  modes?: string[]
  /** Only at an `after` point: only when the command succeeded, or failed. */
  on?: "success" | "failure"
  run?: string
  /** Only with `run`: a command that repairs what it found. */
  fix?: string
  /** Only with `run`: seconds before it counts as failed (default 60). */
  timeout?: number
  prompt?: string
}

/** The fields a hook may have. */
export const HOOK_KEYS = [
  "name",
  "paths",
  "modes",
  "on",
  "run",
  "fix",
  "timeout",
  "prompt",
] as const

export type FieldValue = string | boolean | string[] | number[] | Hook[]

/** A shape a string field must match, and how to describe it in an error. */
export type FieldPattern = { regex: RegExp; hint: string }

export type FieldSpec = {
  key: string
  description: string
  /** Defaults to "string". */
  type?: FieldType
  example: FieldValue
  required?: boolean
  /** Required for any field an op uses, since ops become shell commands. */
  pattern?: FieldPattern
}

export type SectionValues = Record<string, FieldValue>

/**
 * What a section holds in the config: one object of fields, or, for a section
 * that allows several instances, a list of them, each with a unique `name`.
 */
export type SectionEntry = SectionValues | SectionValues[]

export type Detection = {
  /** Guessed field values; may be partial or empty. */
  values: SectionValues
  /**
   * When the checkout has several (one Vercel project per app), each one's
   * values with a `name`; `values` is then the first. Only for sections that
   * allow `multiple`.
   */
  instances?: SectionValues[]
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
  /** Dotted location in the config file: `repo`, `integrations.github`. */
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
  /**
   * Can be configured more than once (two Vercel projects, two Sentry
   * projects): the entry is then a list, each item with a unique `name`.
   */
  multiple?: boolean
  /** How to look values up when detection can't (MCP tools, CLI commands). */
  lookup?: string
  /** Guess values from the checkout. Return undefined when there's no sign of it. */
  detect?(ctx: DetectContext): Detection | undefined
}

/**
 * A job flows need done, independent of the tool that does it. Flows ask for
 * every configured integration that provides it, so a repo can have several.
 */
export type CapabilitySpec = {
  id: string
  name: string
  /** What dev flows use it for. */
  purpose: string
  /**
   * What flows can ask a provider to do: op name → the contract every
   * integration providing this capability implements. Only ops a flow uses.
   */
  ops: Record<string, string>
  /**
   * How far a team lets flows go with an integration for this capability,
   * least first, each including the ones before it. An integration's `use`
   * picks one; without levels, it's just used or not.
   */
  levels?: { id: string; description: string }[]
  /** The level of an integration whose `use` doesn't say. */
  defaultLevel?: string
}

/**
 * The ways an agent can reach an integration, in the order flows prefer them:
 * its MCP server, its CLI, or its HTTP API directly.
 */
export const ACCESS_KINDS = ["mcp", "cli", "api"] as const

export type AccessKind = (typeof ACCESS_KINDS)[number]

export type AccessSpec = {
  /** An MCP server, by the name its tools show up under (`Linear`). */
  mcp?: { server: string }
  /**
   * A CLI on PATH, and a command that exits 0 only when it's signed in (none
   * when it has no sign-in of its own).
   */
  cli?: { bin: string; auth?: string[] }
  /**
   * The HTTP API: where it lives (prose, for people), and the environment
   * variables that usually hold a token, the first set one wins, unless
   * configure recorded another source for this machine. Ops write the token
   * as `{token}`, which becomes a shell expression for it (`$NAME`,
   * `$(cat '/path')`), so its value never passes through the agent or the
   * config.
   */
  api?: { base: string; token: string[] }
}

/**
 * How an integration does one op: one string when it's the same whatever the
 * access (a URL shape), else one per access kind it supports, in the order to
 * try them (usually `ACCESS_KINDS` order; an op lists a more exact way first).
 * An op the tool has nothing for is `{ unsupported: <why> }` alone, so flows
 * skip what needs it and say so rather than improvise.
 */
export type OpImpl =
  | string
  | Partial<Record<VariantKind, string>>
  | { unsupported: string }

/**
 * A way to run an op: one of the access kinds, or `script`, which resolution
 * adds (first) for an op with an adapter.
 */
export type VariantKind = AccessKind | "script"

/**
 * A section at `integrations.<id>` for a third-party tool. For each capability
 * it provides, it says how to perform that capability's ops: prose or a
 * command, where `{field}` stands for a required field's value, `{field|x}`
 * for an optional field's value or `x` when it's unset, and `{field:encoded}`
 * URL-encodes it; `<N>`-style placeholders are filled in by the flow. An integration configured several times gets its ops filled
 * once per instance, so each op must name the instance it acts on.
 */
export type IntegrationSpec = SectionSpec & {
  access: AccessSpec
  provides: Record<string, Record<string, OpImpl>>
  /**
   * Capabilities it provides that are used only when an entry's `use` names
   * them, for ones most repos on the integration get elsewhere (GitHub's
   * issues, next to Linear or Jira). Without `use`, flows leave them out.
   */
  optIn?: string[]
  /** Ops this integration can run as code: see `Adapter`. */
  adapters?: Record<string, Adapter>
}

/** What an adapter gets: the entry's values, its arguments, and its access. */
export type AdapterInput = {
  values: SectionValues
  /** `--name value` arguments, named after the op's `<name>` placeholders. */
  args: Record<string, string>
  /** The API token, read from the integration's token variable, when `needs` is `api`. */
  token?: string
  fetch: typeof fetch
}

/**
 * An op as code instead of prose: run by `adapter.ts`, so a lookup that needs
 * exact filtering, paging, or several calls happens in one deterministic step
 * rather than as instructions the agent follows. Integrations ship built-in
 * ones; a repo adds or overrides them in `.agent-flows/adapters/<integration>.ts`
 * (`export const adapters = { findIssue: {...} }`). Runtime code: Node
 * built-ins only.
 */
export type Adapter = {
  /** What it reaches the integration through; it runs only when that works. */
  needs?: "api" | "cli"
  /** Argument names, each passed as `--name <value>`. */
  args?: string[]
  /** Arguments it takes when the op is given them, and does without. */
  optional?: string[]
  /** What it prints, as JSON. Throw to fail. */
  run(input: AdapterInput): Promise<unknown>
}

/**
 * Upgrades a config from `from` to `from + 1`. Every format change ships one,
 * so older committed configs keep working.
 */
export type Migration = {
  from: number
  migrate(config: Record<string, unknown>): Record<string, unknown>
}

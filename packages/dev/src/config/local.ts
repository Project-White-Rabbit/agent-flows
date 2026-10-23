// Settings for this machine and this repo that never go in the committed
// config: where each integration's API token comes from. They live in the
// repo's git common dir, so every worktree shares them and nothing can commit
// them. Only where a token is, never the token itself.
//
// Runtime code: Node built-ins only.

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/**
 * Where a token comes from: an environment variable, a file holding just the
 * token, or a command that prints it (a password manager's CLI).
 */
export type TokenSource =
  | { env: string }
  | { file: string }
  | { command: string }

export type LocalSettings = { tokens: Record<string, TokenSource> }

export function localPath(gitCommonDir: string): string {
  return path.join(gitCommonDir, "agent-flows", "local.json")
}

export function gitCommonDir(root: string): string | undefined {
  try {
    return execFileSync(
      "git",
      ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim()
  } catch {
    return undefined
  }
}

export function readLocal(root: string): LocalSettings {
  const dir = gitCommonDir(root)
  if (!dir) {
    return { tokens: {} }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(localPath(dir), "utf8"))
    if (parsed && typeof parsed.tokens === "object" && parsed.tokens) {
      return { tokens: parsed.tokens }
    }
  } catch {
    // Missing or unreadable: no local settings.
  }
  return { tokens: {} }
}

export function writeLocal(root: string, settings: LocalSettings): string {
  const dir = gitCommonDir(root)
  if (!dir) {
    throw new Error("not inside a git repository")
  }
  const file = localPath(dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  })
  return file
}

/** An env var name: what `{ env }` may hold, so it's safe in `$NAME`. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Problems with a source; none means it can be saved. */
export function checkSource(source: TokenSource): string[] {
  if ("env" in source) {
    return ENV_NAME.test(source.env)
      ? []
      : [`\`${source.env}\` isn't an environment variable name`]
  }
  if ("file" in source) {
    if (!path.isAbsolute(source.file) || /['"$`\\\n]/.test(source.file)) {
      return [
        "the token file must be an absolute path without quotes, `$`, backticks, or backslashes",
      ]
    }
    return []
  }
  return source.command.trim() ? [] : ["the token command is empty"]
}

/**
 * The token as a shell expression for an op to splice in, so its value stays
 * out of the agent's context: `$NAME`, `$(cat '/path')`, or `$(command)`.
 */
export function tokenExpression(source: TokenSource): string {
  if ("env" in source) {
    return `$${source.env}`
  }
  if ("file" in source) {
    return `$(cat '${source.file}')`
  }
  return `$(${source.command})`
}

/** How a source reads in a report: never the value. */
export function describeSource(source: TokenSource): string {
  if ("env" in source) {
    return `env ${source.env}`
  }
  if ("file" in source) {
    return `file ${source.file}`
  }
  return `command \`${source.command}\``
}

/**
 * Whether a source can produce a token here, without producing it: the
 * variable is set, or the file is non-empty. A command can't be checked
 * without running it (a password manager may prompt), so it counts as ready.
 */
export function sourceReady(
  source: TokenSource,
  env: Record<string, string | undefined>,
): boolean {
  if ("env" in source) {
    return Boolean(env[source.env])
  }
  if ("file" in source) {
    try {
      return fs.statSync(source.file).size > 0
    } catch {
      return false
    }
  }
  return true
}

/** The token itself, for an adapter. Undefined when the source has none. */
export function readToken(
  source: TokenSource,
  env: Record<string, string | undefined>,
): string | undefined {
  if ("env" in source) {
    return env[source.env] || undefined
  }
  if ("file" in source) {
    try {
      return fs.readFileSync(source.file, "utf8").trim() || undefined
    } catch {
      return undefined
    }
  }
  try {
    return (
      execFileSync("sh", ["-c", source.command], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      }).trim() || undefined
    )
  } catch {
    return undefined
  }
}

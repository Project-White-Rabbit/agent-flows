// The shape every source-control host's `checks` op prints, and the CLI call
// the built-in adapters read it through. `ready.ts ci` reads this shape from
// any host, so its settle, timeout, and stall logic is the same everywhere.
//
// Runtime code: Node built-ins only.

import { spawnSync } from "node:child_process"

export const CHECK_STATES = [
  "pass",
  "fail",
  "pending",
  "skipping",
  "cancelled",
] as const

export type CheckState = (typeof CHECK_STATES)[number]

export type Check = {
  name: string
  state: CheckState
  /** The check's page. */
  link?: string
  /** The id `checkLog` reads its log by; none for an outside service's status. */
  log?: string
  /** Merging into the base needs it to pass; unset when no base was given. */
  required?: boolean
}

export type Checks = { checks: Check[] }

/** Sorted by name, so two snapshots of the same run compare equal. */
export function sortChecks(checks: Check[]): Check[] {
  return [...checks].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || (a.log ?? "").localeCompare(b.log ?? ""),
  )
}

/** A CLI's stdout, or an error with its stderr. */
export function cli(bin: string, args: string[]): string {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `\`${bin} ${args.join(" ")}\` failed: ${(result.stderr || result.stdout || String(result.error)).trim()}`,
    )
  }
  return result.stdout
}

/** One JSON value per line, as `gh api --jq` prints a list. */
export function jsonLines<T>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T)
}

// Fail when a change to the plugin doesn't bump its version. Claude Code only
// updates an installed plugin when .claude-plugin/plugin.json's version
// changes, so an unbumped change would never reach anyone.
//
// Usage: node scripts/check-version.ts <base-ref>   (CI: origin/main)

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { isMain } from "../src/commands/lib.ts"

export const PLUGIN_JSON = ".claude-plugin/plugin.json"

/** Files that don't change what users get; editing only these needs no bump. */
export function shipsToUsers(file: string): boolean {
  return !/\.test\.ts$/.test(file)
}

export function parseVersion(version: unknown): number[] | undefined {
  const match =
    typeof version === "string" ? version.match(/^(\d+)\.(\d+)\.(\d+)$/) : null
  return match ? match.slice(1).map(Number) : undefined
}

/** Positive when a > b. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i]
    }
  }
  return 0
}

/** Why the change needs a different version, or undefined when it's fine. */
export function versionProblem(
  changed: string[],
  baseVersion: string | undefined,
  headVersion: string | undefined,
): string | undefined {
  const head = parseVersion(headVersion)
  if (!head) {
    return `${PLUGIN_JSON} version must be X.Y.Z, got ${JSON.stringify(headVersion)}`
  }
  const base = parseVersion(baseVersion)
  if (!base || !changed.some(shipsToUsers)) {
    return undefined
  }
  if (compareVersions(head, base) <= 0) {
    return `packages/dev changed (${changed.filter(shipsToUsers).join(", ")}) but ${PLUGIN_JSON} is still ${headVersion}; bump it past ${baseVersion} so installed plugins update.`
  }
  return undefined
}

function git(args: string[], cwd: string): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  return result.status === 0 ? result.stdout : undefined
}

function versionAt(ref: string, pkgDir: string): string | undefined {
  const text = git(["show", `${ref}:./${PLUGIN_JSON}`], pkgDir)
  return text === undefined ? undefined : JSON.parse(text).version
}

function main(): void {
  const baseRef = process.argv[2]
  if (!baseRef) {
    throw new Error("usage: check-version.ts <base-ref>")
  }
  const pkgDir = path.resolve(import.meta.dirname, "..")
  const mergeBase = git(["merge-base", baseRef, "HEAD"], pkgDir)?.trim()
  if (!mergeBase) {
    throw new Error(`can't find a merge base with ${baseRef}`)
  }
  const changed = (
    git(["diff", "--name-only", mergeBase, "--relative", "--", "."], pkgDir) ??
    ""
  )
    .split("\n")
    .filter(Boolean)
  const baseVersion = versionAt(mergeBase, pkgDir)
  const headVersion = JSON.parse(
    fs.readFileSync(path.join(pkgDir, PLUGIN_JSON), "utf8"),
  ).version
  const problem = versionProblem(changed, baseVersion, headVersion)
  if (problem) {
    console.error(`[check-version] ${problem}`)
    process.exit(1)
  }
  console.log(
    `[check-version] ok: ${baseVersion ?? "(new)"} -> ${headVersion}, ${changed.length} file(s) changed`,
  )
}

if (isMain(import.meta.filename)) {
  main()
}

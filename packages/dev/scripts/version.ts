// The plugin's version, in .claude-plugin/plugin.json. Claude Code only
// updates an installed plugin when that version changes, so every change that
// ships needs a version no earlier release has used.
//
//   bump <patch|minor|major>  Set the version one step past the latest of main
//                             and the released tags. Re-running gives the same
//                             result, so it's safe to run again after a rebase.
//   check <base-ref>          CI, on PRs: fail when the plugin changed but its
//                             version isn't past <base-ref>'s or is released.
//   release                   CI, on main: print the tag to create, nothing if
//                             this version is already released as is, and fail
//                             when it was released with different contents.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { isMain } from "../src/commands/lib.ts"

export const PLUGIN_JSON = ".claude-plugin/plugin.json"
export const TAG_PREFIX = "agent-flows--v"

export type Level = "patch" | "minor" | "major"

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
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  if (!x || !y) {
    throw new Error(`can't compare ${a} and ${b}`)
  }
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) {
      return x[i] - y[i]
    }
  }
  return 0
}

export function latest(versions: (string | undefined)[]): string | undefined {
  return versions
    .filter((v): v is string => parseVersion(v) !== undefined)
    .sort(compareVersions)
    .at(-1)
}

export function nextVersion(version: string, level: Level): string {
  const parsed = parseVersion(version)
  if (!parsed) {
    throw new Error(`not an X.Y.Z version: ${version}`)
  }
  const [major, minor, patch] = parsed
  if (level === "major") {
    return `${major + 1}.0.0`
  }
  return level === "minor"
    ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`
}

/** Why a PR's version won't do, or undefined when it's fine. */
export function versionProblem(opts: {
  changed: string[]
  head: string | undefined
  base: string | undefined
  released: string[]
}): string | undefined {
  const { changed, head, base, released } = opts
  if (!parseVersion(head)) {
    return `${PLUGIN_JSON} version must be X.Y.Z, got ${JSON.stringify(head)}`
  }
  const shipped = changed.filter(shipsToUsers)
  if (shipped.length === 0) {
    return undefined
  }
  const fix = "run `bun run bump <patch|minor|major>` in packages/dev"
  if (released.includes(head as string)) {
    return `${head} is already released; ${fix}.`
  }
  if (
    base &&
    parseVersion(base) &&
    compareVersions(head as string, base) <= 0
  ) {
    return `packages/dev changed (${shipped.join(", ")}) but ${PLUGIN_JSON} is ${head}, not past ${base} on the base branch; ${fix}.`
  }
  return undefined
}

const pkgDir = path.resolve(import.meta.dirname, "..")

function git(args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: pkgDir, encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function readVersion(): string | undefined {
  return JSON.parse(fs.readFileSync(path.join(pkgDir, PLUGIN_JSON), "utf8"))
    .version
}

function versionAt(ref: string): string | undefined {
  const text = git(["show", `${ref}:./${PLUGIN_JSON}`])
  return text === undefined ? undefined : JSON.parse(text).version
}

/** Released versions, from the remote's tags (local tags if it's unreachable). */
function releasedVersions(): string[] {
  const remote = git(["ls-remote", "--tags", "origin", `${TAG_PREFIX}*`])
  const refs =
    remote !== undefined
      ? remote.split("\n").map((line) => line.split("refs/tags/")[1])
      : (git(["tag", "--list", `${TAG_PREFIX}*`]) ?? "").split("\n")
  return refs
    .filter((ref) => ref && !ref.endsWith("^{}"))
    .map((ref) => ref.slice(TAG_PREFIX.length))
    .filter((v) => parseVersion(v))
}

/** Plugin files that ship and differ between `from` and the working tree. */
function shippedChangesSince(from: string): string[] {
  return (git(["diff", "--name-only", from, "--relative", "--", "."]) ?? "")
    .split("\n")
    .filter(Boolean)
    .filter(shipsToUsers)
}

function bump(level: string | undefined): void {
  if (level !== "patch" && level !== "minor" && level !== "major") {
    throw new Error("usage: bump <patch|minor|major>")
  }
  const current = readVersion()
  const from =
    latest([versionAt("origin/main"), ...releasedVersions()]) ?? current
  if (!from) {
    throw new Error(`${PLUGIN_JSON} has no version to bump`)
  }
  const next = nextVersion(from, level)
  const file = path.join(pkgDir, PLUGIN_JSON)
  const text = fs.readFileSync(file, "utf8")
  fs.writeFileSync(
    file,
    text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${next}"`),
  )
  console.log(`[version] ${current} -> ${next} (${level} past ${from})`)
}

function check(baseRef: string | undefined): void {
  if (!baseRef) {
    throw new Error("usage: check <base-ref>")
  }
  const mergeBase = git(["merge-base", baseRef, "HEAD"])
  if (!mergeBase) {
    throw new Error(`can't find a merge base with ${baseRef}`)
  }
  const changed = shippedChangesSince(mergeBase)
  const head = readVersion()
  const problem = versionProblem({
    changed,
    head,
    // The base branch's version now, not where this branch started: if
    // another PR took the next version first, this one has to move past it.
    base: versionAt(baseRef),
    released: releasedVersions(),
  })
  if (problem) {
    console.error(`[version] ${problem}`)
    process.exit(1)
  }
  console.log(
    `[version] ok: ${head}, ${changed.length} shipped file(s) changed`,
  )
}

function release(): void {
  const version = readVersion()
  if (!parseVersion(version)) {
    throw new Error(`${PLUGIN_JSON} version must be X.Y.Z, got ${version}`)
  }
  const tag = `${TAG_PREFIX}${version}`
  if (!releasedVersions().includes(version as string)) {
    console.log(tag)
    return
  }
  git(["fetch", "--quiet", "origin", "tag", tag])
  const changed = shippedChangesSince(tag)
  if (changed.length > 0) {
    console.error(
      `[version] ${version} is already released as ${tag}, but the plugin changed since (${changed.join(", ")}). Users won't get these changes until the version is bumped: run \`bun run bump patch\` in packages/dev and merge it.`,
    )
    process.exit(1)
  }
}

function main(): void {
  const [command, arg] = process.argv.slice(2)
  if (command === "bump") {
    bump(arg)
  } else if (command === "check") {
    check(arg)
  } else if (command === "release") {
    release()
  } else {
    throw new Error("usage: version.ts <bump|check|release> [arg]")
  }
}

if (isMain(import.meta.filename)) {
  main()
}

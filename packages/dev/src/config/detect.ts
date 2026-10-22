// Builds the read-only view of a checkout that section detectors share, and
// runs every detector. Detection reads local files and git metadata only: it
// never calls a service and never reads a real .env file.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { SECTIONS } from "./sections/index.ts"
import type { DetectContext, Detection, SectionSpec } from "./types.ts"

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

export function dependencyNames(packageJson: string): string[] {
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>
    const names: string[] = []
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const deps = parsed[field]
      if (deps && typeof deps === "object") {
        names.push(...Object.keys(deps))
      }
    }
    return names
  } catch {
    return []
  }
}

const PY_NAME = "[A-Za-z0-9][A-Za-z0-9._-]*"

/**
 * Package names in a requirements*.txt (`name==1.0` lines) or pyproject.toml
 * (`"name>=1",` list items, and `name = "^1"` keys under a dependencies table).
 */
export function pythonDependencyNames(file: string, text: string): string[] {
  const names = new Set<string>()
  const pyproject = file.endsWith("pyproject.toml")
  let table = ""
  for (const line of text.split("\n")) {
    if (!pyproject) {
      const match = line.match(new RegExp(`^(${PY_NAME})`))
      if (match) {
        names.add(match[1].toLowerCase())
      }
      continue
    }
    const header = line.match(/^\s*\[([^\]]+)\]/)
    if (header) {
      table = header[1]
      continue
    }
    const item = line.match(new RegExp(`^\\s*["'](${PY_NAME})`))
    const key = line.match(new RegExp(`^(${PY_NAME})\\s*=`))
    if (item) {
      names.add(item[1].toLowerCase())
    } else if (key && /dependencies/.test(table) && key[1] !== "python") {
      names.add(key[1].toLowerCase())
    }
  }
  return [...names]
}

export function createDetectContext(root: string): DetectContext {
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
    return result.status === 0 ? result.stdout.trim() : undefined
  }
  const resolve = (file: string) =>
    path.isAbsolute(file) ? file : path.join(root, file)
  const read = (file: string) => readText(resolve(file))
  const readJson = (file: string) => {
    const text = read(file)
    if (text === undefined) {
      return undefined
    }
    try {
      const parsed: unknown = JSON.parse(text)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }
  const tracked = (git(["ls-files"]) ?? "").split("\n").filter(Boolean)
  const manifests = tracked.filter((f) => path.basename(f) === "package.json")
  const pythonManifests = tracked.filter((f) =>
    /(^|\/)(pyproject\.toml|requirements[^/]*\.txt)$/.test(f),
  )
  const dependencies: { file: string; name: string }[] = []
  for (const file of manifests) {
    for (const name of dependencyNames(read(file) ?? "")) {
      dependencies.push({ file, name })
    }
  }
  for (const file of pythonManifests) {
    for (const name of pythonDependencyNames(file, read(file) ?? "")) {
      dependencies.push({ file, name })
    }
  }
  return {
    root,
    git,
    gitCommonDir: git([
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
    tracked,
    read,
    readJson,
    packageDirs: [
      "",
      ...manifests.map((f) => path.dirname(f)).filter((d) => d !== "."),
    ],
    dependsOn: (pattern) =>
      dependencies
        .filter(({ name }) => pattern.test(name))
        .map(({ file, name }) => `${file} depends on ${name}`),
    envTemplates: tracked
      .filter((f) => /(^|\/)\.env\.(example|sample|template)$/.test(f))
      .map((file) => ({ file, text: read(file) ?? "" })),
  }
}

/** Every section's detection, keyed by path; sections with no sign are absent. */
export function detectSections(
  ctx: DetectContext,
  registry: SectionSpec[] = SECTIONS,
): Record<string, Detection> {
  const found: Record<string, Detection> = {}
  for (const spec of registry) {
    const detection = spec.detect?.(ctx)
    if (detection) {
      found[spec.path] = detection
    }
  }
  return found
}

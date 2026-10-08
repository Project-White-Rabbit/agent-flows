import fs from "node:fs"
import path from "node:path"
import type { GeneratedFile } from "./kit.js"

export interface WriteOptions {
  /** Directory output paths resolve against. */
  rootDir: string
  /**
   * Report drift without writing (for CI). Every file whose content differs
   * from disk is listed in `changed`.
   */
  check?: boolean
}

export interface WriteResult {
  /** Paths whose content differed from disk (written unless `check`). */
  changed: string[]
  unchanged: number
}

/** Strip trailing whitespace from every line so output is stable under editors. */
export function normalizeGenerated(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
}

/**
 * Write generated files, skipping those already up to date. With `check`,
 * nothing is written and the result lists what would change, so a build can
 * fail when committed skills drift from their flows.
 */
export function writeGeneratedFiles(
  files: readonly GeneratedFile[],
  options: WriteOptions,
): WriteResult {
  const result: WriteResult = { changed: [], unchanged: 0 }
  const seen = new Map<string, string>()
  for (const file of files) {
    const previous = seen.get(file.path)
    if (previous !== undefined) {
      throw new Error(
        `Output path "${file.path}" is produced by both ${previous} and ${file.flowId}/${file.target}`,
      )
    }
    seen.set(file.path, `${file.flowId}/${file.target}`)

    const fullPath = path.resolve(options.rootDir, file.path)
    const content = normalizeGenerated(file.content)
    const existing = fs.existsSync(fullPath)
      ? fs.readFileSync(fullPath, "utf-8")
      : null
    if (existing === content) {
      result.unchanged += 1
      continue
    }
    result.changed.push(file.path)
    if (!options.check) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
    }
  }
  return result
}

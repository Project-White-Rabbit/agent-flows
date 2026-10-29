// Lay out a file the plugin writes in the repo the way the repo's own
// formatter would, so a configure run and the next lint fix don't keep undoing
// each other. Only the repo's installed Biome or Prettier, only on that one
// file; never a download, and never a whole-repo command.
//
// Runtime code: Node built-ins only.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export type Formatter = "biome" | "prettier"

export type FormatResult =
  | { formatted: Formatter }
  | { formatted: false; reason: string }

const BIOME_CONFIGS = ["biome.json", "biome.jsonc"]
const PRETTIER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.json5",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.toml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.ts",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
]

const TIMEOUT_MS = 15_000

function hasPrettierKey(root: string): boolean {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    )
    return manifest?.prettier !== undefined
  } catch {
    return false
  }
}

/** The formatter the repo configures at its root, Biome first. */
export function configuredFormatter(root: string): Formatter | undefined {
  const exists = (file: string) => fs.existsSync(path.join(root, file))
  if (BIOME_CONFIGS.some(exists)) {
    return "biome"
  }
  if (PRETTIER_CONFIGS.some(exists) || hasPrettierKey(root)) {
    return "prettier"
  }
  return undefined
}

function formatArgs(formatter: Formatter, file: string): string[] {
  // Biome fails on a file its config ignores unless told not to; Prettier
  // skips one quietly.
  return formatter === "biome"
    ? ["format", "--write", "--no-errors-on-unmatched", file]
    : ["--write", file]
}

/**
 * Format `file` (relative to `root`) in place with the repo's formatter. Any
 * reason it can't (none configured, not installed, it failed) is returned,
 * never thrown: the file as written stays.
 */
export function formatFile(root: string, file: string): FormatResult {
  const formatter = configuredFormatter(root)
  if (!formatter) {
    return { formatted: false, reason: "no formatter configured" }
  }
  const bin = path.join(root, "node_modules", ".bin", formatter)
  if (!fs.existsSync(bin)) {
    return { formatted: false, reason: `${formatter} not installed` }
  }
  const result = spawnSync(bin, formatArgs(formatter, file), {
    cwd: root,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  })
  if (result.error) {
    const timedOut =
      (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
    return {
      formatted: false,
      reason: timedOut
        ? `${formatter} timed out`
        : `${formatter} didn't run: ${result.error.message}`,
    }
  }
  if (result.status !== 0) {
    return {
      formatted: false,
      reason: `${formatter} exited ${result.status ?? result.signal}`,
    }
  }
  return { formatted: formatter }
}

// The base's SessionStart hook: tells the session where the base is
// installed, so front-end skills can read its flows. It puts the path in the
// session's context (for reading files) and exports it as $DEV_FLOWS_BASE
// through Claude Code's CLAUDE_ENV_FILE (for the commands the flows run).
// It never fails the session: on any error it says nothing.

import { appendFileSync, readFileSync } from "node:fs"
import path from "node:path"
import { isMain } from "./lib.ts"

export const ROOT_VAR = "DEV_FLOWS_BASE"

export interface BaseInfo {
  root: string
  version: string
  contract: number
}

/** The installed base's version and flow contract. */
export function readBaseInfo(root: string): BaseInfo {
  const plugin = JSON.parse(
    readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"),
  )
  const manifest = JSON.parse(
    readFileSync(path.join(root, "flows", "manifest.json"), "utf8"),
  )
  return { root, version: plugin.version, contract: manifest.contract }
}

/** A shell line exporting the root, quoted for any path. */
export function exportLine(root: string): string {
  return `export ${ROOT_VAR}='${root.replaceAll("'", `'\\''`)}'\n`
}

/** What the session's context gets told. */
export function contextLine(info: BaseInfo): string {
  return `dev-flows-base ${info.version} is installed at ${info.root} (flow contract ${info.contract}). Front-end plugin commands read their flows from ${info.root}/flows; in a shell, $${ROOT_VAR} holds this path.`
}

function main(): void {
  try {
    const root =
      process.env.CLAUDE_PLUGIN_ROOT ??
      path.resolve(import.meta.dirname, "..", "..")
    const info = readBaseInfo(root)
    const envFile = process.env.CLAUDE_ENV_FILE
    if (envFile) {
      appendFileSync(envFile, exportLine(root))
    }
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: contextLine(info),
        },
      }),
    )
  } catch {
    // A broken hook must not break the session; the front end's skill says
    // what to do when it can't find the base.
  }
}

if (isMain(import.meta.filename)) {
  main()
}

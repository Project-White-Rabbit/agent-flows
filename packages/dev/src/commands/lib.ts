// Shared helpers for the plugin's command scripts. Commands run straight from
// the installed plugin with `node` (type stripping), so everything here and in
// the commands must use Node built-ins only: there is no node_modules at
// runtime.

import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"

export type RunResult = {
  status: number | null
  stdout: string
  stderr: string
}

export function run(command: string, args: string[], cwd?: string): RunResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** True when `moduleFilename` is the script node was asked to run. */
export function isMain(moduleFilename: string): boolean {
  const entry = process.argv[1]
  if (!entry) {
    return false
  }
  try {
    return realpathSync(entry) === realpathSync(moduleFilename)
  } catch {
    return false
  }
}

/** Run `main`, printing a thrown error's message and exiting 1. */
export function runMain(main: () => void | Promise<void>): void {
  Promise.resolve()
    .then(main)
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

// Shared helpers for the plugin's command scripts. Commands run straight from
// the installed plugin with `node` (type stripping), so everything here and in
// the commands must use Node built-ins only: there is no node_modules at
// runtime.

import { spawnSync } from "node:child_process"
import { readFileSync, realpathSync } from "node:fs"

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

/** Bad arguments or input: the command exits 2, so the skill can say what's wrong. */
export class UsageError extends Error {}

export const USAGE_EXIT = 2

/** `--name value` flags; `switches` take no value and read as `yes`. */
export type Flags = Map<string, string>

export function parseFlags(
  args: string[],
  switches: ReadonlySet<string> = new Set(),
): Flags {
  const flags: Flags = new Map()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const name = arg.startsWith("--") ? arg.slice(2) : undefined
    if (name && switches.has(name)) {
      flags.set(name, "yes")
    } else if (name && args[i + 1] !== undefined) {
      flags.set(name, args[++i])
    } else {
      throw new UsageError(`expected \`--<name> <value>\`, got \`${arg}\``)
    }
  }
  return flags
}

export function requiredFlag(flags: Flags, name: string): string {
  const value = flags.get(name)
  if (!value) {
    throw new UsageError(`--${name} <value> is required`)
  }
  return value
}

export function readJson<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch (error) {
    throw new UsageError(
      `can't read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Run the subcommand `argv` names with its parsed arguments. No subcommand, or
 * `help`, prints `usage` and exits 0; an unknown one prints it and exits 1; a
 * UsageError prints its message and exits 2.
 */
export function runSubcommand<A>(
  argv: string[],
  usage: string,
  subcommands: Record<string, (args: A) => void>,
  parse: (rest: string[]) => A,
): void {
  const [command, ...rest] = argv
  const subcommand = command ? subcommands[command] : undefined
  if (!subcommand) {
    console.log(usage)
    process.exitCode = command && command !== "help" ? 1 : 0
    return
  }
  try {
    subcommand(parse(rest))
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error
    }
    console.error(error.message)
    process.exitCode = USAGE_EXIT
  }
}

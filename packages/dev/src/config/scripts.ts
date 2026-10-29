// A checkout's package scripts as detection reads them: which package runner
// runs them, the command that runs one from the repo root, and what a script
// runs one level down, through the scripts it calls. Read-only, like the rest
// of detection.
//
// Runtime code: Node built-ins only.

import path from "node:path"
import type { DetectContext } from "./types.ts"

export type Runner = "bun" | "pnpm" | "yarn" | "npm"

const LOCKFILES: [string, Runner][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
]

/** The runner of the nearest lockfile at or above `dir`, else npm. */
export function runnerFor(ctx: DetectContext, dir: string): Runner {
  for (let current = dir || "."; ; current = path.posix.dirname(current)) {
    const at = current === "." ? "" : current
    for (const [lockfile, runner] of LOCKFILES) {
      if (ctx.tracked.includes(at ? `${at}/${lockfile}` : lockfile)) {
        return runner
      }
    }
    if (!at) {
      return "npm"
    }
  }
}

/** A package script, run from the repo root. */
export function scriptCommand(
  runner: Runner,
  dir: string,
  script: string,
): string {
  if (!dir) {
    return `${runner} run ${script}`
  }
  switch (runner) {
    case "bun":
      return `bun run --cwd ${dir} ${script}`
    case "pnpm":
      return `pnpm --dir ${dir} run ${script}`
    case "yarn":
      return `yarn --cwd ${dir} run ${script}`
    default:
      return `npm --prefix ${dir} run ${script}`
  }
}

/** A dependency's binary, run through the package runner. */
export function binCommand(runner: Runner, bin: string): string {
  switch (runner) {
    case "bun":
      return `bunx ${bin}`
    case "pnpm":
      return `pnpm exec ${bin}`
    case "yarn":
      return `yarn ${bin}`
    default:
      return `npx ${bin}`
  }
}

/**
 * A command that mustn't run outside CI or a release: it deploys, publishes,
 * pushes, seeds, or migrates. A migration's diff, check, or status only reads.
 */
export const UNSAFE_COMMAND =
  /\b(?:publish|deploy|release|push|upload|apply|seed)\b|\bmigrate\b(?![\s:_-]*(?:diff|check|status|verify|lint)\b)/i

/** A test runner's binary, however it's run: `vitest`, `bunx vitest`, `node_modules/.bin/jest`. */
const RUNNER_BIN = /(?:^|[\s/])(vitest|jest|mocha|ava|pytest)(?=\s|$)/
/** A command that runs a test suite, rather than only the tests a change touches. */
const TEST_RUN = new RegExp(
  `${RUNNER_BIN.source}|\\bplaywright\\s+test\\b|\\bbun\\s+test\\b`,
)
const CHANGED_TESTS = /--changed|--onlyChanged|--findRelatedTests|\brelated\b/

/** The `scripts` of the package at `dir` ("" for the root). */
export function packageScripts(
  ctx: DetectContext,
  dir: string,
): Record<string, string> {
  const scripts = ctx.readJson(
    dir ? `${dir}/package.json` : "package.json",
  )?.scripts
  if (!scripts || typeof scripts !== "object") {
    return {}
  }
  return Object.fromEntries(
    Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  )
}

/** A script's body split into the commands it chains. */
export function splitSteps(body: string): string[] {
  return body
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((step) => step.trim())
    .filter(Boolean)
}

/** Runner flags that take a value, and the ones that point at a directory. */
const VALUE_FLAGS = new Set([
  "--filter",
  "-F",
  "--cwd",
  "--dir",
  "-C",
  "--prefix",
  "--workspace",
])
const DIR_FLAGS = new Set(["--cwd", "--dir", "-C", "--prefix"])
const WORKSPACE_FLAGS = new Set([
  "--filter",
  "-F",
  "--workspace",
  "--workspaces",
  "-ws",
  "-r",
  "--recursive",
])
const RUN_ALL = new Set(["run-s", "run-p", "npm-run-all", "npm-run-all2"])

type Call = {
  /** Script names, or `*` globs for npm-run-all. */
  names: string[]
  /** The package directory they're looked up in. */
  dir: string
  /**
   * Looked up in workspace packages rather than one: those a `--filter` or
   * `--workspace` names (by package name or directory), or every one.
   */
  workspace?: string[]
}

/** The package scripts one command runs, or undefined when it runs none. */
function callOf(step: string): Call | { commands: string[] } | undefined {
  const words = step.split(/\s+/).filter(Boolean)
  // Variables set for the command: `NODE_ENV=test vitest`.
  while (words[0] && /^\w+=/.test(words[0])) {
    words.shift()
  }
  const [bin, ...rest] = words
  if (!bin) {
    return undefined
  }
  if (bin === "concurrently") {
    const names: string[] = []
    const commands: string[] = []
    for (const [, a, b] of step.matchAll(/"([^"]+)"|'([^']+)'/g)) {
      const quoted = (a ?? b) as string
      const short = /^(?:npm|bun|pnpm|yarn):(.+)$/.exec(quoted)
      if (short) {
        names.push(short[1] as string)
      } else {
        commands.push(quoted)
      }
    }
    return names.length > 0 ? { names, dir: "" } : { commands }
  }
  const unquote = (word: string) => word.replace(/^(["'])(.*)\1$/, "$2")
  if (RUN_ALL.has(bin)) {
    const names = rest.filter((w) => !w.startsWith("-")).map(unquote)
    return { names, dir: "" }
  }
  if (bin === "turbo") {
    const tasks = rest.filter((w) => !w.startsWith("-") && w !== "run")
    return { names: tasks.map(unquote), dir: "", workspace: [] }
  }
  if (!["bun", "npm", "pnpm", "yarn"].includes(bin)) {
    return undefined
  }
  let dir = ""
  let workspace: string[] | undefined
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] as string
    if (!word.startsWith("-")) {
      positional.push(word)
      continue
    }
    const [flag, inline] = word.split("=", 2) as [string, string | undefined]
    const takesValue = VALUE_FLAGS.has(flag) || (bin === "npm" && flag === "-w")
    const value = inline ?? (takesValue ? rest[++i] : undefined)
    if (DIR_FLAGS.has(flag) && value) {
      dir = path.posix.normalize(unquote(value)).replace(/^\.$/, "")
    }
    if (WORKSPACE_FLAGS.has(flag) || (bin === "npm" && flag === "-w")) {
      workspace ??= []
      if (value && takesValue) {
        workspace.push(unquote(value))
      }
    }
  }
  const [first, second] = positional
  let name: string | undefined
  if (first === "run" || first === "run-script") {
    name = second
  } else if (bin === "npm" && (first === "test" || first === "t")) {
    name = "test"
  } else if ((bin === "yarn" || bin === "pnpm") && first) {
    // `yarn lint` runs the script when there is one; the lookup decides.
    name = first
  }
  return name ? { names: [unquote(name)], dir, workspace } : undefined
}

/** A `*` glob as a regex; `*` stops at `stop`. */
function globRegExp(glob: string, stop: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${escaped.replaceAll("*", `[^${stop}]*`)}$`)
}

function matching(scripts: Record<string, string>, name: string): string[] {
  const glob = globRegExp(name, ":")
  return Object.keys(scripts).filter((s) => glob.test(s))
}

/** The workspace packages a filter names, by package name or directory. */
function workspaceDirs(ctx: DetectContext, filters: string[]): string[] {
  const dirs = ctx.packageDirs.filter((d) => d !== "")
  if (filters.length === 0) {
    return dirs
  }
  return dirs.filter((dir) => {
    const name = ctx.readJson(`${dir}/package.json`)?.name
    return filters.some((filter) => {
      const glob = globRegExp(filter.replace(/^\.\//, ""), "")
      return glob.test(dir) || (typeof name === "string" && glob.test(name))
    })
  })
}

export type ScriptStep = {
  /** The command as the script chains it. */
  command: string
  /** The scripts it runs, with where they are and what they run. */
  calls: { name: string; dir: string; body: string }[]
}

/** What a script's body runs, each command with the scripts it calls, one level down. */
export function resolveScript(
  ctx: DetectContext,
  dir: string,
  body: string,
): ScriptStep[] {
  const out: ScriptStep[] = []
  const pending = splitSteps(body)
  for (let command = pending.shift(); command; command = pending.shift()) {
    const call = callOf(command)
    if (call && "commands" in call) {
      out.push({ command, calls: [] })
      pending.unshift(...call.commands.flatMap(splitSteps))
      continue
    }
    const calls: ScriptStep["calls"] = []
    for (const name of call?.names ?? []) {
      const dirs = call?.workspace
        ? workspaceDirs(ctx, call.workspace)
        : [path.posix.join(dir, call?.dir ?? "").replace(/^\.$/, "")]
      for (const at of dirs) {
        const scripts = packageScripts(ctx, at)
        for (const found of matching(scripts, name)) {
          calls.push({ name: found, dir: at, body: scripts[found] as string })
        }
      }
    }
    out.push({ command, calls })
  }
  return out
}

/** Every command a resolved script runs: its own, and those of the scripts it calls. */
export function commandsOf(steps: ScriptStep[]): string[] {
  return steps.flatMap((step) => [
    step.command,
    ...step.calls.flatMap((call) => splitSteps(call.body)),
  ])
}

/** The first command a resolved script runs that mustn't run locally. */
export function unsafeCommand(steps: ScriptStep[]): string | undefined {
  return commandsOf(steps).find((command) => UNSAFE_COMMAND.test(command))
}

/** Whether a resolved script runs a whole test suite. */
export function runsTests(steps: ScriptStep[]): boolean {
  return commandsOf(steps).some((command) => {
    const call = callOf(command)
    const callsTest =
      call !== undefined &&
      "names" in call &&
      call.names.some((name) => /^test(?::|$)/.test(name))
    return (TEST_RUN.test(command) || callsTest) && !CHANGED_TESTS.test(command)
  })
}

/** The test runners a resolved script runs, by binary name, first run first. */
export function testRunners(steps: ScriptStep[]): string[] {
  const bins = commandsOf(steps).flatMap((command) =>
    [...command.matchAll(new RegExp(RUNNER_BIN.source, "g"))].map(
      (match) => match[1] as string,
    ),
  )
  return [...new Set(bins)]
}

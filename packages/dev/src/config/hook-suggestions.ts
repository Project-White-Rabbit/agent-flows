// Hooks configure can offer, from what the checkout already has: checks CI
// runs that ready would otherwise meet only after pushing (a version bump, a
// changelog, a migration), the scripts that fix them, and teardown scripts for
// after a merge. Read-only, like detection, and only ever offered: a guess at
// a command is never written without the user, and configure tries each one
// before it's written.
//
// Runtime code: Node built-ins only.

import path from "node:path"
import { toInstanceName } from "./instances.ts"
import type { DetectContext, Hook } from "./types.ts"

export type HookSuggestion = {
  /** The point's config path: `ready.before`. */
  point: string
  hook: Hook
  /** Why it's offered, and what to check before taking it. */
  evidence: string
}

/** A check ready can run before cleanup: version, changelog, migrations. */
const CHECK_NAME =
  /^(?:(?:check|verify|lint)[-:_]?(?:version|changelog|migrations?)|(?:version|changelog|migrations?)[-:_]?(?:check|verify|lint)|db:verify-migrations?)$/

/** A script that bumps the version: a check's likely fix. */
const BUMP_NAME = /^(?:bump|version[-:_]?bump|bump[-:_]?version)$/

/** Teardown after a merge: a server or services brought down. */
const TEARDOWN_NAME =
  /^(?:(?:dev[-:_]?)?(?:server|services|stack|docker|db)[-:_]?(?:down|stop|teardown)|teardown|down)$/

const CHECK_FILE =
  /(?:check|verify)[-_]?(?:version|changelog|migrations?)|(?:version|changelog|migrations?)[-_]?(?:check|verify|gate)/
const TEARDOWN_FILE = /(?:server|services|stack)[-_]?(?:down|stop)|teardown/

/** CI lines worth running before cleanup, and ones that must never run locally. */
const CI_CHECK = /version|changelog|migrat/i
const CI_UNSAFE =
  /\b(?:publish|deploy|release|push|upload|apply|migrate(?!.*(?:check|verify|status)))\b/i

type Runner = "bun" | "pnpm" | "yarn" | "npm"

const LOCKFILES: [string, Runner][] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
]

function runnerFor(ctx: DetectContext, dir: string): Runner {
  for (let current = dir; ; current = path.posix.dirname(current)) {
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
function scriptCommand(runner: Runner, dir: string, script: string): string {
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

/** A tracked script file, run by what its extension needs. */
function fileCommand(file: string): string {
  const ext = path.extname(file)
  if (ext === ".sh" || ext === ".bash") {
    return `bash ${file}`
  }
  if ([".ts", ".js", ".mjs", ".cjs", ".mts"].includes(ext)) {
    return `node ${file}`
  }
  if (ext === ".py") {
    return `python3 ${file}`
  }
  return `./${file}`
}

/**
 * The `run:` commands in a GitHub Actions workflow, one per line: single-line
 * ones and each line of a block. Enough for suggestions; not a YAML parser.
 */
export function workflowCommands(text: string): string[] {
  const out: string[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i] as string)
    if (!match) {
      continue
    }
    const [, indent, rest] = match as unknown as [string, string, string]
    if (!/^[|>][-+]?\s*$/.test(rest)) {
      out.push(rest.replace(/^(["'])(.*)\1$/, "$2").trim())
      continue
    }
    for (i++; i < lines.length; i++) {
      const line = lines[i] as string
      if (line.trim() && line.search(/\S/) <= indent.length) {
        i--
        break
      }
      if (line.trim() && !line.trim().startsWith("#")) {
        out.push(line.trim())
      }
    }
  }
  return out.filter(Boolean)
}

/** Shell around a command rather than one: control flow, assignments, output. */
const SHELL_FRAGMENT =
  /^(?:if|then|else|elif|fi|for|while|do|done|case|esac|echo|printf|exit|export|set|cd)\b|^[A-Za-z_][A-Za-z0-9_]*=|[\\;{}]\s*$|\$\(/

/**
 * A CI command as a hook would run it: the base ref becomes `{base}`, and one
 * that needs anything else from CI's context, or is shell around a command,
 * isn't offered.
 */
function localCommand(command: string): string | undefined {
  if (SHELL_FRAGMENT.test(command)) {
    return undefined
  }
  const local = command.replace(
    /"?(?:origin\/)?\$\{?GITHUB_BASE_REF\}?"?/g,
    "{base}",
  )
  return /\$\{\{|\$[A-Z_]/.test(local) ? undefined : local
}

export function suggestHooks(ctx: DetectContext): HookSuggestion[] {
  const out: HookSuggestion[] = []
  const bumps = new Map<string, string>()

  for (const dir of ctx.packageDirs) {
    const manifest = ctx.readJson(dir ? `${dir}/package.json` : "package.json")
    const scripts = manifest?.scripts
    if (!scripts || typeof scripts !== "object") {
      continue
    }
    const runner = runnerFor(ctx, dir || ".")
    const names = Object.keys(scripts)
    const bump = names.find((name) => BUMP_NAME.test(name))
    if (bump) {
      bumps.set(dir, `${scriptCommand(runner, dir, bump)} patch`)
    }
    const where = dir ? `${dir}/package.json` : "package.json"
    for (const name of names) {
      if (CHECK_NAME.test(name)) {
        out.push({
          point: "ready.before",
          hook: { name, run: scriptCommand(runner, dir, name) },
          evidence: `${where} has a \`${name}\` script`,
        })
      } else if (TEARDOWN_NAME.test(name)) {
        out.push({
          point: "merge.after",
          hook: { name, on: "success", run: scriptCommand(runner, dir, name) },
          evidence: `${where} has a \`${name}\` script; check it takes no arguments, or which branch to tear down`,
        })
      }
    }
  }

  for (const file of ctx.tracked) {
    const base = path.basename(file, path.extname(file))
    if (!/(^|\/)scripts\//.test(file) || base.endsWith(".test")) {
      continue
    }
    if (CHECK_FILE.test(base)) {
      out.push({
        point: "ready.before",
        hook: { name: base, run: fileCommand(file) },
        evidence: `${file} looks like a check; see what arguments it takes (\`{base}\` is the merge base)`,
      })
    } else if (TEARDOWN_FILE.test(base)) {
      out.push({
        point: "merge.after",
        hook: { name: base, on: "success", run: fileCommand(file) },
        evidence: `${file} looks like teardown; see what arguments it takes (\`{branch}\` is the merged branch)`,
      })
    }
  }

  for (const file of ctx.tracked.filter((f) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f),
  )) {
    const text = ctx.read(file) ?? ""
    // Only what runs on a pull request is something ready would meet.
    if (!/\bpull_request(?:_target)?\b/.test(text)) {
      continue
    }
    for (const command of workflowCommands(text)) {
      const local = localCommand(command)
      if (!local || !CI_CHECK.test(local) || CI_UNSAFE.test(local)) {
        continue
      }
      const script = /([\w./-]+\.(?:ts|js|mjs|sh|py))/.exec(local)?.[1]
      const name = script
        ? path.basename(script, path.extname(script))
        : (local.split(/\s+/).find((word) => CI_CHECK.test(word)) ?? "ci-check")
      out.push({
        point: "ready.before",
        hook: { name, run: local },
        evidence: `${file} runs it in CI, so ready would otherwise meet it only after pushing`,
      })
    }
  }

  // A version check's fix is its package's bump script, when there's one.
  for (const { hook } of out) {
    if (hook.run && /version/i.test(`${hook.name} ${hook.run}`) && !hook.fix) {
      const dir = [...bumps.keys()]
        .filter(
          (d) =>
            d === "" ||
            hook.run?.includes(`${d}/`) ||
            hook.run?.includes(` ${d} `),
        )
        .sort((a, b) => b.length - a.length)[0]
      if (dir !== undefined) {
        hook.fix = bumps.get(dir)
      }
    }
  }

  // One suggestion per command, named uniquely at its point.
  const seen = new Set<string>()
  const names = new Set<string>()
  return out.filter((suggestion) => {
    const key = `${suggestion.point} ${suggestion.hook.run}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    let name = toInstanceName(suggestion.hook.name)
    for (let n = 2; names.has(`${suggestion.point} ${name}`); n++) {
      name = `${toInstanceName(suggestion.hook.name)}-${n}`
    }
    names.add(`${suggestion.point} ${name}`)
    suggestion.hook.name = name
    return true
  })
}

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
import {
  packageScripts,
  runnerFor,
  scriptCommand,
  splitSteps,
  UNSAFE_COMMAND,
} from "./scripts.ts"
import { detectReady } from "./sections/ready.ts"
import type { DetectContext, Hook } from "./types.ts"

export type HookSuggestion = {
  /** The point's config path: `ready.before`. */
  point: string
  hook: Hook
  /** Why it's offered, and what to check before taking it. */
  evidence: string
}

/**
 * A check ready can run before cleanup: version, changelog, migrations, under
 * an optional prefix (`db:migrate:check`, `db:verify-migrations`).
 */
const CHECK_NAME =
  /^(?:[\w-]+:)?(?:(?:check|verify|lint)[-:_]?(?:version|changelog|migrat(?:e|ions?))|(?:version|changelog|migrat(?:e|ions?))[-:_]?(?:check|verify|lint))$/

/** A script that bumps the version: a check's likely fix. */
const BUMP_NAME = /^(?:bump|version[-:_]?bump|bump[-:_]?version)$/

/** Teardown after a merge: a server or services brought down. */
const TEARDOWN_NAME =
  /^(?:(?:dev[-:_]?)?(?:server|services|stack|docker|db)[-:_]?(?:down|stop|teardown)|teardown|down)$/

const CHECK_FILE =
  /(?:check|verify)[-_]?(?:version|changelog|migrations?)|(?:version|changelog|migrations?)[-_]?(?:check|verify|gate)/
const TEARDOWN_FILE = /(?:server|services|stack)[-_]?(?:down|stop)|teardown/

/** A branch's resources go once it lands, or once it's thrown away. */
const TEARDOWN_POINTS = ["merge.after", "close.after"] as const

/** CI lines worth running before cleanup. */
const CI_CHECK = /version|changelog|migrat/i

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A tracked script file, run the way the repo runs it: a package script that
 * runs just that file, else its shebang's interpreter, else what its
 * extension needs (a JS or TS file through the lockfile's runner, bun or node).
 */
function fileCommand(ctx: DetectContext, file: string): string {
  for (const dir of ctx.packageDirs) {
    const relative = dir ? path.posix.relative(dir, file) : file
    if (relative.startsWith("..")) {
      continue
    }
    const runs = new RegExp(
      `(?:^|\\s)(?:\\./)?${escapeRegExp(relative)}(?:\\s|$)`,
    )
    for (const [name, body] of Object.entries(packageScripts(ctx, dir))) {
      if (splitSteps(body).length === 1 && runs.test(body)) {
        return scriptCommand(runnerFor(ctx, dir), dir, name)
      }
    }
  }
  const shebang = /^#!\s*(\S+)(?:\s+(.*))?/.exec(
    ctx.read(file)?.split("\n", 1)[0] ?? "",
  )
  if (shebang) {
    const [, program, args = ""] = shebang as unknown as [
      string,
      string,
      string,
    ]
    // `#!/usr/bin/env -S deno run -A` runs everything after `-S`.
    const interpreter =
      path.posix.basename(program) === "env"
        ? args.replace(/^-S\s+/, "").trim()
        : [path.posix.basename(program), args.trim()].filter(Boolean).join(" ")
    if (interpreter) {
      return `${interpreter} ${file}`
    }
  }
  const ext = path.extname(file)
  if (ext === ".sh" || ext === ".bash") {
    return `bash ${file}`
  }
  if ([".ts", ".js", ".mjs", ".cjs", ".mts"].includes(ext)) {
    const runner = runnerFor(ctx, path.posix.dirname(file))
    return `${runner === "bun" ? "bun" : "node"} ${file}`
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
    const names = Object.keys(packageScripts(ctx, dir))
    if (names.length === 0) {
      continue
    }
    const runner = runnerFor(ctx, dir)
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
        for (const point of TEARDOWN_POINTS) {
          out.push({
            point,
            hook: {
              name,
              on: "success",
              run: scriptCommand(runner, dir, name),
            },
            evidence: `${where} has a \`${name}\` script; check it takes no arguments, or which branch to tear down`,
          })
        }
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
        hook: { name: base, run: fileCommand(ctx, file) },
        evidence: `${file} looks like a check; see what arguments it takes (\`{base}\` is the merge base)`,
      })
    } else if (TEARDOWN_FILE.test(base)) {
      for (const point of TEARDOWN_POINTS) {
        out.push({
          point,
          hook: {
            name: base,
            on: "success",
            run: fileCommand(ctx, file),
          },
          evidence: `${file} looks like teardown; see what arguments it takes (\`{branch}\` is the ${point === "merge.after" ? "merged" : "closed"} branch)`,
        })
      }
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
      if (!local || !CI_CHECK.test(local) || UNSAFE_COMMAND.test(local)) {
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

  // A check the detected ready checks already run would run twice.
  const readyRuns = (detectReady(ctx)?.runs ?? []).map(normalizeCommand)
  const covered = (run: string) => {
    // A script file counts as run when any of their commands names it.
    const file = /[\w./-]+\.(?:ts|js|mjs|cjs|mts|sh|bash|py)\b/
      .exec(run)?.[0]
      ?.replace(/^\.\//, "")
    return (
      readyRuns.includes(normalizeCommand(run)) ||
      (file !== undefined && readyRuns.some((r) => r.includes(file)))
    )
  }

  // One suggestion per command, named uniquely at its point.
  const seen = new Set<string>()
  const names = new Set<string>()
  return out.filter((suggestion) => {
    const key = `${suggestion.point} ${suggestion.hook.run}`
    if (
      seen.has(key) ||
      (suggestion.point === "ready.before" &&
        suggestion.hook.run &&
        covered(suggestion.hook.run))
    ) {
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

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ")
}

// Path-scoped rule files: the agent instructions a host loads only when the
// files it works on match the rule's globs, so reading the root's AGENTS.md
// and CLAUDE.md misses them. Two layouts: Claude Code's `.claude/rules/**/*.md`
// (a `paths` list in the frontmatter; a rule with none applies everywhere)
// and Cursor's `.cursor/rules/**/*.mdc` (`globs`, or `alwaysApply: true`).
// Either may sit in any directory, with globs relative to that directory.
//
// Runtime code: Node built-ins only.

import fs from "node:fs"
import path from "node:path"
import { globRegex } from "./hooks.ts"

const LAYOUTS = [
  { dir: ".claude/rules", ext: ".md" },
  { dir: ".cursor/rules", ext: ".mdc" },
]

export type RuleScope = {
  /** Globs the rule applies to; none with `always`. */
  globs: string[]
  /** It applies whatever changed. */
  always: boolean
}

/** `{a,b}` alternatives spelled out, since `globRegex` has none. */
export function expandBraces(glob: string): string[] {
  const match = glob.match(/\{([^{}]*)\}/)
  if (!match || match.index === undefined) {
    return [glob]
  }
  const head = glob.slice(0, match.index)
  const tail = glob.slice(match.index + match[0].length)
  return (match[1] as string)
    .split(",")
    .flatMap((part) => expandBraces(`${head}${part}${tail}`))
}

function unquote(text: string): string {
  return text.trim().replace(/^["']|["']$/g, "")
}

/** A frontmatter value: a `[a, b]` list, a `- item` block, or a comma-separated string. */
function listValue(lines: string[], key: string): string[] | undefined {
  const index = lines.findIndex((line) => line.startsWith(`${key}:`))
  if (index < 0) {
    return undefined
  }
  const inline = (lines[index] as string).slice(key.length + 1).trim()
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(unquote)
      .filter(Boolean)
  }
  if (inline) {
    return inline.split(",").map(unquote).filter(Boolean)
  }
  const items: string[] = []
  for (const line of lines.slice(index + 1)) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (!item) {
      break
    }
    items.push(unquote(item[1] as string))
  }
  return items
}

/** What a rule file's frontmatter scopes it to. */
export function ruleScope(text: string, cursor: boolean): RuleScope {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const lines = front ? (front[1] as string).split(/\r?\n/) : []
  const globs = (listValue(lines, cursor ? "globs" : "paths") ?? []).flatMap(
    expandBraces,
  )
  const always = cursor
    ? lines.some((line) => /^alwaysApply:\s*true\s*$/.test(line))
    : globs.length === 0
  return { globs, always }
}

function ruleFilesUnder(root: string, dir: string, ext: string): string[] {
  const found: string[] = []
  const walk = (rel: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = path.posix.join(rel, entry.name)
      if (entry.isDirectory()) {
        walk(child)
      } else if (entry.name.endsWith(ext)) {
        found.push(child)
      }
    }
  }
  walk(dir)
  return found
}

/**
 * The rule files in `dirs` (repo-relative, `.` for the root) that apply to
 * any of `files`: always-on ones, and ones with a glob a file matches,
 * relative to the directory the rules sit in.
 */
export function matchingRules(
  root: string,
  dirs: string[],
  files: string[],
): string[] {
  const out: string[] = []
  for (const dir of dirs) {
    for (const layout of LAYOUTS) {
      const base = path.posix.join(dir, layout.dir)
      for (const file of ruleFilesUnder(root, base, layout.ext)) {
        let text: string
        try {
          text = fs.readFileSync(path.join(root, file), "utf8")
        } catch {
          continue
        }
        const scope = ruleScope(text, layout.ext === ".mdc")
        const prefix = dir === "." ? "" : `${dir}/`
        const local = files
          .filter((f) => f.startsWith(prefix))
          .map((f) => f.slice(prefix.length))
        const patterns = scope.globs.map((glob) =>
          globRegex(glob.replace(/^\.?\//, "")),
        )
        // A bare `*.ts`-style glob matches at any depth, as both hosts read it.
        const anyDepth = scope.globs
          .filter((glob) => !glob.includes("/"))
          .map((glob) => globRegex(`**/${glob}`))
        if (
          (scope.always && local.length > 0) ||
          local.some((f) => [...patterns, ...anyDepth].some((p) => p.test(f)))
        ) {
          out.push(file)
        }
      }
    }
  }
  return out.sort()
}

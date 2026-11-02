// An issue tracker's projects beyond the default one: the others this repo's
// work goes in, each a name, or a name with the paths whose changes belong to
// it. Flows match a project a person names against these first, look for
// duplicates across all of them, and sync files a branch's new issue in the
// one whose paths its changes match.
//
// Runtime code: commands import this straight from the installed plugin, so it
// uses Node built-ins only.

import { globRegex } from "./hooks.ts"
import type { FieldSpec, FieldValue, ProjectRoute } from "./types.ts"

/** The `projects` field, for an integration whose issues go in projects. */
export function projectsField(what: string): FieldSpec {
  return {
    key: "projects",
    type: "project[]",
    description: `Other ${what} this repo's issues go in, beside \`project\`: each a name, or \`{ "name", "paths" }\` with globs (\`*\` within a directory, \`**\` across them) for the changes that belong to it, so sync files a branch's issue there`,
    example: [{ name: "Mobile", paths: ["apps/mobile/**"] }, "Platform"],
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/** The project's name, from either form. */
export function projectName(route: ProjectRoute): string {
  return typeof route === "string" ? route : route.name
}

/** Problems in the project list at `where`, and keys a newer plugin may know. */
export function checkProjects(
  value: unknown,
  where: string,
  warnings: string[],
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [`${where} must be a non-empty list of projects`]
  }
  const issues: string[] = []
  const names = new Set<string>()
  for (const [index, item] of value.entries()) {
    const at = `${where}[${index}]`
    let name: unknown = item
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const entry = item as Record<string, unknown>
      name = entry.name
      for (const key of Object.keys(entry)) {
        if (key !== "name" && key !== "paths") {
          warnings.push(
            `unknown field "${at}.${key}" (kept as is; it may come from a newer plugin)`,
          )
        }
      }
      if (
        entry.paths !== undefined &&
        !(
          Array.isArray(entry.paths) &&
          entry.paths.length > 0 &&
          entry.paths.every(nonEmpty)
        )
      ) {
        issues.push(`${at}.paths must be a list of non-empty globs`)
      }
    } else if (typeof item !== "string") {
      issues.push(`${at} must be a project's name, or { "name", "paths" }`)
      continue
    }
    if (!nonEmpty(name)) {
      issues.push(
        `${at}${typeof item === "string" ? "" : ".name"} must be a project's name`,
      )
      continue
    }
    const key = name.trim().toLowerCase()
    if (names.has(key)) {
      issues.push(`${where} lists "${name}" twice`)
    }
    names.add(key)
  }
  return issues
}

/** Where a branch's changes put its issue. */
export type Routed = {
  project: string
  /** How many of the changed files its paths match. */
  files: number
  /** Others that matched as many, after it in the list. */
  tied?: string[]
}

/** The configured projects that claim paths, in config order. */
export function routesOf(value: FieldValue | undefined): {
  name: string
  paths: string[]
}[] {
  if (!Array.isArray(value)) {
    return []
  }
  return (value as unknown[]).flatMap((item) =>
    typeof item === "object" &&
    item !== null &&
    nonEmpty((item as ProjectRoute & object).name) &&
    Array.isArray((item as { paths?: unknown }).paths)
      ? [item as { name: string; paths: string[] }]
      : [],
  )
}

/**
 * The project whose paths match the most changed files, the first listed on
 * a tie; undefined when none match, so the default project applies.
 */
export function routeProject(
  value: FieldValue | undefined,
  changed: string[],
): Routed | undefined {
  const counted = routesOf(value).map((route) => {
    const patterns = route.paths.map(globRegex)
    return {
      name: route.name,
      files: changed.filter((file) => patterns.some((p) => p.test(file)))
        .length,
    }
  })
  const most = Math.max(0, ...counted.map((c) => c.files))
  if (most === 0) {
    return undefined
  }
  const [first, ...tied] = counted.filter((c) => c.files === most)
  return {
    project: first.name,
    files: most,
    ...(tied.length > 0 ? { tied: tied.map((t) => t.name) } : {}),
  }
}

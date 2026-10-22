import path from "node:path"
import type { SectionSpec } from "../types.ts"

/** Graphite's repo config: `{ "trunk": "main" }` or `{ "trunks": [{ "name": "main" }] }`. */
export function parseGraphiteConfig(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as {
      trunk?: unknown
      trunks?: { name?: unknown }[]
    }
    if (typeof parsed.trunk === "string") {
      return parsed.trunk
    }
    const first = parsed.trunks?.[0]?.name
    return typeof first === "string" ? first : undefined
  } catch {
    return undefined
  }
}

export const graphite: SectionSpec = {
  path: "services.graphite",
  name: "Graphite",
  purpose: "Stacked branches and PRs",
  fields: [
    {
      key: "trunk",
      description: "Trunk branch stacks build on",
      example: "main",
      required: true,
    },
  ],
  lookup: "`gt trunk`",
  detect(ctx) {
    const text = ctx.gitCommonDir
      ? ctx.read(path.join(ctx.gitCommonDir, ".graphite_repo_config"))
      : undefined
    const trunk = text ? parseGraphiteConfig(text) : undefined
    return trunk
      ? { values: { trunk }, evidence: ["gt repo config in .git"] }
      : undefined
  },
}

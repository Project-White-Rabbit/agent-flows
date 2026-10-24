import path from "node:path"
import type { IntegrationSpec } from "../types.ts"

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

export const graphite: IntegrationSpec = {
  path: "integrations.graphite",
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
  // Never `gt trunk`: on a repo Graphite hasn't set up, it sets it up.
  lookup:
    "The `trunk` in `.graphite_repo_config` in the git common dir, else ask. Never run `gt` to look it up: on a repo Graphite hasn't set up, it initializes it",
  access: { cli: { bin: "gt" } },
  provides: {
    stacking: {
      parent: { cli: "`gt parent`" },
      track: { cli: "`gt track --parent <parent>`" },
      // `gt sync` fast-forwards the local trunk, which it skips when trunk's
      // worktree has changes, so a worktree branch would never catch up.
      restack: {
        cli: "When `gt parent` is the configured `trunk` (`<trunk>` below): `git fetch origin <trunk>`, then `git rebase origin/<trunk>`. Otherwise `gt restack`. Not `gt sync`, which skips silently in a worktree whose trunk checkout has changes",
      },
      continue: { cli: "`gt continue`" },
      submit: { cli: "`gt submit --draft --no-edit --no-interactive`" },
    },
  },
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

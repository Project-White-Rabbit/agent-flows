import path from "node:path"
import { downstack, prUrl } from "../adapters/graphite.ts"
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
      // Not `gt move`: onto trunk it rebases onto the local trunk, which a
      // worktree branch never fast-forwards. The merge base with <old> is
      // where the branch's own commits start, squash-merged or not.
      reparent: {
        cli: 'When <onto> is the configured `trunk`: `git fetch origin <onto>`, then `git rebase --onto origin/<onto> "$(git merge-base HEAD <old>)"` (`origin/<old>` in place of `<old>` when there\'s no local branch `<old>`). Otherwise `git rebase --onto <onto> "$(git merge-base HEAD <old>)"`. Then `gt track --parent <onto>`. On conflicts, resolve and `git rebase --continue`, then `gt track --parent <onto>`',
      },
      rename: {
        cli: "`if gt parent >/dev/null 2>&1; then gt rename --no-interactive <name>; else git branch -m <name>; fi`",
      },
      submit: {
        cli: "`gt submit --draft --no-edit --no-interactive`. It prints a line per pull request it pushed, with its URL in Graphite's app (`https://app.graphite.` …); the host's URL is the source-control entry's `currentPr`",
      },
      // Also an adapter (`adapters/graphite.ts`), run first: it reads the
      // parents Graphite records, without parsing `gt log`.
      downstack: {
        cli: "`gt log short --stack`: one branch per line, the top of the stack first and trunk last, the checked-out one marked. `chain` is the branches from just above trunk up to the checked-out one, bottom first; `above` counts the lines above it; `size` counts every branch but trunk",
      },
      // Also an adapter, which needs neither `gt` nor a network.
      prUrl: {
        cli: "`https://app.graphite.com/github/pr/<owner>/<repo>/<N>` from a `https://github.com/<owner>/<repo>/pull/<N>` URL; none for any other host",
      },
      // Lands bottom-up, retargeting and restacking each next branch itself.
      mergeStack: { cli: "`gt merge --no-interactive`" },
    },
  },
  adapters: { downstack, prUrl },
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

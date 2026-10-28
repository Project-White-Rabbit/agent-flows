import { hookField } from "../hooks.ts"
import type { SectionSpec } from "../types.ts"

export const ready: SectionSpec = {
  path: "ready",
  name: "Ready checks",
  purpose:
    "The commands ready runs before it publishes a branch (unset, it runs the scripts of each package the branch touches), the steps it skips, the CI checks it ignores, and the repo's own hooks at its steps",
  fields: [
    {
      key: "fix",
      type: "string[]",
      description:
        "Commands that fix the tree in place (formatters, lint autofixes, code generators), run in order from the repo root before the checks. `{base}` is the branch's merge base",
      example: ["bun run lint:fix"],
    },
    {
      key: "checks",
      type: "string[]",
      description:
        "Commands that verify the branch (lint, type checks, the tests it touches, a build), run in order from the repo root; none of them may deploy, publish, migrate, or write to a shared service. `{base}` is the branch's merge base",
      example: ["bun run validate"],
    },
    {
      key: "skip",
      type: "string[]",
      description:
        "Steps ready skips on every run: `cleanup` (what must change with the branch), `tests` (writing tests for new behavior), `fix` and `checks` (the local fix and check commands, before the first push and before every CI fix push), `local` (all four), `ci` (waiting on CI and fixing it), `reviews` (automated reviewers' threads), `all` (every step: ready only commits, publishes, and syncs). A run's `--skip` adds to these",
      example: ["tests"],
    },
    {
      key: "ignoreChecks",
      type: "string[]",
      description:
        "CI check names ready neither waits on nor fixes, such as preview deploys or optional coverage. `*` matches any run of characters, case aside. A run's `--ignore-check` adds to these",
      example: ["Vercel*", "codecov/*"],
    },
    hookField("ready.before"),
    hookField("ready.beforePublish"),
    hookField("ready.after"),
  ],
  lookup:
    "Leave it out to run each touched package's own scripts and every step, and to wait on every CI check. Set `fix` and `checks` when the repo has one command for the whole check (`bun run validate`), or its own script that picks the checks a branch needs; `skip` and `ignoreChecks` when the team never wants a step, or a check is slow or optional (a preview deploy); `before` for a check CI runs that ready would otherwise find only after pushing (a version bump), or a rule that applies only when certain paths change; `beforePublish` and `after` for the repo's own steps at those points",
}

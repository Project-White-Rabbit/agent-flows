import type { SectionSpec } from "../types.ts"

export const ready: SectionSpec = {
  path: "ready",
  name: "Ready checks",
  purpose:
    "The commands ready runs before it publishes a branch; unset, it runs the scripts of each package the branch touches",
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
  ],
  lookup:
    "Leave it out to run each touched package's own scripts. Set it when the repo has one command for the whole check (`bun run validate`), or its own script that picks the checks a branch needs",
}

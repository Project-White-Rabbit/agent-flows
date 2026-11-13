import path from "node:path"
import type { SectionSpec } from "../types.ts"

const SHOW_PLACES = ["page", "design", "browser"]

export const prototype: SectionSpec = {
  path: "prototype",
  name: "Prototype",
  purpose:
    "The look prototype's mockups take, so they look like the team's product, where they're shown, and where the team keeps them, when it does",
  fields: [
    {
      key: "style",
      description:
        "Where a mockup's look comes from: the files that hold the product's design tokens (a `globals.css`, a Tailwind config, a theme module), or the look in words. Without it, prototype reads the repo's own styles, else uses a plain neutral look",
      example: "apps/web/src/app/globals.css (dark theme)",
    },
    {
      key: "show",
      type: "string[]",
      description:
        "Where a mockup is shown, in the order prototype tries them: `page` (a page the host publishes, such as Claude's artifacts), `design` (the team's design tool, a `design` integration at `write`), `browser` (a local page in a browser). The first that works in the session shows it, and the rest are backups. A place left out is never used to show one (`design` mode still puts a mockup in the design tool when asked). Default: all three, in that order",
      example: ["page", "browser"],
      check: (value) =>
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((place) => SHOW_PLACES.includes(place as string)) &&
        new Set(value as unknown[]).size === value.length
          ? undefined
          : "must list distinct places from `page`, `design`, and `browser`",
    },
    {
      key: "dir",
      description:
        "A folder in the repo, relative to its root, where every mockup is also saved as `<name>.html`, for a team that keeps its mockups. Off by default: mockups stay in a scratch folder in the worktree's git dir, outside the working tree. Prototype never commits them either way",
      example: "prototypes",
      check: (value) =>
        typeof value !== "string" ||
        path.isAbsolute(value) ||
        value.split(/[\\/]/).some((part) => part === ".." || part === ".git")
          ? "must be a folder inside the repo, relative to its root"
          : undefined,
    },
  ],
  lookup:
    'Leave all three out to take the look from the repo\'s own styles, show mockups wherever the session can, and keep them out of the working tree. Set `style` when the product\'s look lives in one file worth naming (its CSS variables or Tailwind theme) or has a rule the files don\'t show (always dark). Set `show` when the team wants mockups in a particular place first, or never in one (`["page", "browser"]` keeps them out of the design tool). Set `dir` only when the team asks to keep mockups in the repo',
}

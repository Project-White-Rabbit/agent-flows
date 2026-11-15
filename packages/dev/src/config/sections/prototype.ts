import path from "node:path"
import type { SectionSpec } from "../types.ts"

const SHOW_PLACES = ["page", "design", "browser"]

export const prototype: SectionSpec = {
  path: "prototype",
  name: "Prototype",
  purpose:
    "The look prototype's mockups take, so they look like the team's product, where they're shown, and how the team keeps them, when it does",
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
    {
      key: "index",
      description:
        "A Markdown file in the repo, relative to its root, where prototype records each mockup: what it shows and the links that outlast the session (the hosted page, such as a Claude artifact; where it is in the design tool; the page kept in `dir`). An entry is updated in place as its mockup changes, and text outside the entries is left alone. Use it alone to keep where mockups are without keeping their pages, or with `dir` to list the kept pages too. Off by default. Prototype never commits it",
      example: "docs/prototypes.md",
      check: (value) =>
        typeof value !== "string" ||
        path.isAbsolute(value) ||
        value.split(/[\\/]/).some((part) => part === ".." || part === ".git") ||
        !/\.(md|markdown|mdx)$/i.test(value)
          ? "must be a Markdown file inside the repo, relative to its root"
          : undefined,
    },
  ],
  lookup:
    'Leave them all out to take the look from the repo\'s own styles, show mockups wherever the session can, and keep them out of the working tree. Set `style` when the product\'s look lives in one file worth naming (its CSS variables or Tailwind theme) or has a rule the files don\'t show (always dark). Set `show` when the team wants mockups in a particular place first, or never in one (`["page", "browser"]` keeps them out of the design tool). Set `dir` only when the team asks to keep the mockup pages in the repo, and `index` when it wants a record of its mockups and where each lives (a hosted page such as a Claude artifact, the design tool), with or without the pages',
}

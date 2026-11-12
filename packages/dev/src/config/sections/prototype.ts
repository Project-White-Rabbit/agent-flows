import type { SectionSpec } from "../types.ts"

export const prototype: SectionSpec = {
  path: "prototype",
  name: "Prototype",
  purpose:
    "The look prototype's mockups take, so they look like the team's product",
  fields: [
    {
      key: "style",
      description:
        "Where a mockup's look comes from: the files that hold the product's design tokens (a `globals.css`, a Tailwind config, a theme module), or the look in words. Without it, prototype reads the repo's own styles, else uses a plain neutral look",
      example: "apps/web/src/app/globals.css (dark theme)",
    },
  ],
  lookup:
    "Leave it out to take the look from the repo's own styles. Set `style` when the product's look lives in one file worth naming (its CSS variables or Tailwind theme) or has a rule the files don't show (always dark)",
}

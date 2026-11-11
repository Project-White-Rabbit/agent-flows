import { hookField } from "../hooks.ts"
import type { SectionSpec } from "../types.ts"

export const preview: SectionSpec = {
  path: "preview",
  name: "Preview",
  purpose:
    "What preview does on the page it opens, once the dev server (the server section) serves it",
  fields: [hookField("preview.afterOpen")],
  lookup:
    "Leave it out unless a page needs a step before the person can see it, such as signing in as a test user: then set `afterOpen`",
}

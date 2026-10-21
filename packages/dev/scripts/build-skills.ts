// Render every dev flow into the plugin's skill files. With --check, write
// nothing and fail when a generated file is stale, so CI catches a flow edited
// without regenerating (or generated output edited by hand).

import path from "node:path"
import { writeGeneratedFiles } from "@agent-flows/core"
import { renderAllSkills } from "../src/flows/index.ts"

const check = process.argv.includes("--check")
const rootDir = path.resolve(import.meta.dirname, "..")
const { changed, unchanged } = writeGeneratedFiles(renderAllSkills(), {
  rootDir,
  check,
})

for (const file of changed) {
  console.log(`[build-skills] ${check ? "stale" : "wrote"} ${file}`)
}
if (check && changed.length > 0) {
  console.error(
    `[build-skills] ${changed.length} generated file(s) out of date. Run \`bun run build\` in packages/dev and commit the result.`,
  )
  process.exit(1)
}
console.log(
  `[build-skills] ${changed.length} ${check ? "stale" : "written"}, ${unchanged} unchanged`,
)

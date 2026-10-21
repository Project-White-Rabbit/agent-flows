import path from "node:path"
import type { Detection, SectionSpec, SectionValues } from "../types.ts"

export const vercel: SectionSpec = {
  path: "services.vercel",
  name: "Vercel",
  purpose: "Preview and production deployments, runtime logs",
  fields: [
    { key: "team", description: "Team id or slug", example: "team_abc123" },
    {
      key: "project",
      description: "Project id or name",
      example: "prj_abc123",
      required: true,
    },
  ],
  lookup: "Vercel MCP, or `vercel project ls`",
  detect(ctx) {
    const evidence = ctx.dependsOn(/^(@vercel\/|vercel$)/)
    let values: SectionValues = {}
    // A monorepo app keeps its own .vercel/ next to its package.json.
    for (const dir of ctx.packageDirs) {
      const file = path.join(dir, ".vercel", "project.json")
      const project = ctx.readJson(file)
      if (!project) {
        continue
      }
      evidence.unshift(`${file} (linked with vercel link)`)
      if (Object.keys(values).length === 0) {
        values = {
          ...(typeof project.orgId === "string" ? { team: project.orgId } : {}),
          ...(typeof project.projectId === "string"
            ? { project: project.projectId }
            : {}),
        }
      }
    }
    if (ctx.tracked.includes("vercel.json")) {
      evidence.push("vercel.json")
    }
    const detection: Detection = { values, evidence }
    return evidence.length > 0 ? detection : undefined
  },
}

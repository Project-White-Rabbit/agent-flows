import type { SectionSpec, SectionValues } from "../types.ts"

export const neon: SectionSpec = {
  path: "services.neon",
  name: "Neon",
  purpose: "Postgres branches per worktree, migrations",
  fields: [
    {
      key: "projectId",
      description: "Neon project id",
      example: "dry-sun-123456",
      required: true,
    },
    {
      key: "parentBranch",
      description: "Branch new dev branches fork from",
      example: "main",
    },
    { key: "database", description: "Database name", example: "neondb" },
  ],
  lookup: "Neon MCP (list projects), or `neonctl projects list`",
  detect(ctx) {
    const evidence = ctx.dependsOn(/^@neondatabase\//)
    const context = ctx.readJson(".neon")
    const projectId =
      typeof context?.projectId === "string" ? context.projectId : undefined
    if (projectId) {
      evidence.unshift(".neon context file (neonctl set-context)")
    }
    for (const { file, text } of ctx.envTemplates) {
      if (/neon\.tech/.test(text)) {
        evidence.push(`${file} has a neon.tech connection string`)
      }
    }
    const values: SectionValues = projectId ? { projectId } : {}
    return evidence.length > 0 ? { values, evidence } : undefined
  },
}

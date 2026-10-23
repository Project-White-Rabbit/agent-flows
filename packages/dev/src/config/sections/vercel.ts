import path from "node:path"
import { uniqueInstanceNames } from "../instances.ts"
import type { Detection, IntegrationSpec, SectionValues } from "../types.ts"

export const vercel: IntegrationSpec = {
  path: "integrations.vercel",
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
    {
      key: "directory",
      description: "App directory it deploys, in a monorepo",
      example: "apps/web",
    },
  ],
  multiple: true,
  lookup: "Vercel MCP, or `vercel project ls`",
  access: {
    mcp: { server: "Vercel" },
    cli: { bin: "vercel", auth: ["vercel", "whoami"] },
    api: { base: "https://api.vercel.com", token: ["VERCEL_TOKEN"] },
  },
  provides: { deployments: {} },
  detect(ctx) {
    const evidence = ctx.dependsOn(/^(@vercel\/|vercel$)/)
    // A monorepo app keeps its own .vercel/ next to its package.json, so each
    // linked app is an instance.
    const instances: SectionValues[] = []
    const names: { preferred: string; fallback: string }[] = []
    for (const dir of ctx.packageDirs) {
      const file = path.join(dir, ".vercel", "project.json")
      const project = ctx.readJson(file)
      if (!project) {
        continue
      }
      evidence.unshift(`${file} (linked with vercel link)`)
      // Named after the project, else its app directory; the full path
      // breaks ties (apps/web vs packages/web).
      names.push({
        preferred:
          typeof project.projectName === "string"
            ? project.projectName
            : dir === ""
              ? "root"
              : path.basename(dir),
        fallback: dir === "" ? "root" : dir,
      })
      instances.push({
        ...(typeof project.orgId === "string" ? { team: project.orgId } : {}),
        ...(typeof project.projectId === "string"
          ? { project: project.projectId }
          : {}),
        ...(dir !== "" ? { directory: dir } : {}),
      })
    }
    if (ctx.tracked.includes("vercel.json")) {
      evidence.push("vercel.json")
    }
    const unique = uniqueInstanceNames(names)
    const detection: Detection = {
      values: instances[0] ?? {},
      ...(instances.length > 1
        ? { instances: instances.map((v, i) => ({ name: unique[i], ...v })) }
        : {}),
      evidence,
    }
    return evidence.length > 0 ? detection : undefined
  },
}

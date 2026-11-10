import path from "node:path"
import { uniqueInstanceNames } from "../../config/instances.ts"
import type {
  Detection,
  IntegrationSpec,
  SectionValues,
} from "../../config/types.ts"
import { SLUG } from "../patterns.ts"

export const vercel: IntegrationSpec = {
  path: "integrations.vercel",
  name: "Vercel",
  purpose: "Preview and production deployments, runtime logs",
  fields: [
    {
      key: "team",
      description: "Team id or slug (never a personal account's id)",
      example: "team_abc123",
      pattern: SLUG,
    },
    {
      key: "project",
      description: "Project id or name",
      example: "prj_abc123",
      required: true,
      pattern: SLUG,
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
  provides: {
    deployments: {
      deployment: {
        mcp: "The Vercel MCP's `list_deployments` for project `{project}` (with the entry's `team`, when it has one), the deployment whose git commit sha (`meta.githubCommitSha`, or the GitLab or Bitbucket one) is <sha>: none is `none`; its `state` (or `readyState`) `READY` is `success`, `ERROR` or `CANCELED` is `failed`, anything else `pending`. `url` its inspector URL; no `steps`",
        cli: "`vercel list {project} --meta githubCommitSha=<sha>` (with `--scope <team>` when the entry has a `team`; `gitlabCommitSha` or `bitbucketCommitSha` for those hosts): no row is `none`; a `Status` of `Ready` is `success`, `Error` or `Canceled` is `failed`, anything else `pending`. `url` its deployment URL; no `steps`",
        api: '`curl -fsSL -H "Authorization: Bearer {token}" "https://api.vercel.com/v6/deployments?projectId={project}&sha=<sha>"` (with `&teamId=<team>` when the entry has a `team`): no deployment is `none`; its `state` read as the MCP variant says, `url` its `inspectorUrl`; no `steps`',
      },
    },
  },
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
      // Linked under a personal account, the org id is that person's user id:
      // teammates can't reach a Hobby project, so it's worth saying.
      const personal =
        typeof project.orgId === "string" && !project.orgId.startsWith("team_")
      if (personal) {
        evidence.push(
          `${file} is linked under a personal Vercel account, not a team: teammates can't reach it, so link it under the team's scope (\`vercel link --scope <team>\`) or keep this entry in this machine's override (\`configure local\`)`,
        )
      }
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
        ...(typeof project.orgId === "string" && !personal
          ? { team: project.orgId }
          : {}),
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

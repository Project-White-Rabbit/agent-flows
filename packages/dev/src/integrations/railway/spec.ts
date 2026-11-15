import path from "node:path"
import { uniqueInstanceNames } from "../../config/instances.ts"
import type {
  Detection,
  IntegrationSpec,
  SectionValues,
} from "../../config/types.ts"
import { SLUG } from "../patterns.ts"

// A service's config-as-code file, at the root of the directory it builds.
const CONFIG_FILE = /(^|\/)railway\.(json|toml)$/

export const railway: IntegrationSpec = {
  path: "integrations.railway",
  name: "Railway",
  purpose: "Preview and production deployments, runtime logs",
  fields: [
    {
      key: "project",
      description: "Project id",
      example: "1b2c3d4e-5f60-7182-93a4-b5c6d7e8f901",
      required: true,
      pattern: SLUG,
    },
    {
      key: "service",
      description: "Service id or name that deploys this repo",
      example: "web",
      required: true,
      pattern: SLUG,
    },
    {
      key: "environment",
      description:
        "Environment id or name the base branch deploys to (default `production`)",
      example: "production",
      pattern: SLUG,
    },
    {
      key: "directory",
      description: "Root directory the service builds, in a monorepo",
      example: "apps/api",
    },
  ],
  multiple: true,
  lookup:
    "Railway MCP (`list-projects`, `list-services`), or `railway list` and `railway status --json` in a linked checkout",
  access: {
    mcp: { server: "Railway" },
    cli: { bin: "railway", auth: ["railway", "whoami"] },
    api: {
      base: "https://backboard.railway.com/graphql/v2",
      token: ["RAILWAY_API_TOKEN"],
    },
  },
  provides: {
    deployments: {
      deployment: {
        mcp: "The Railway MCP's `list-deployments` for service `{service}` in environment `{environment|production}` (`json` on), with the checkout linked to project `{project}`: the deployment whose commit (`meta.commitHash`) is <sha>: none is `none`; its `status` `SUCCESS` or `SLEEPING` is `success`, so is `SKIPPED` (its watch paths left the commit out, so nothing deploys), `FAILED`, `CRASHED`, or `REMOVED` is `failed`, anything else (`QUEUED`, `WAITING`, `INITIALIZING`, `BUILDING`, `DEPLOYING`, `NEEDS_APPROVAL`) `pending`. `url` its page on railway.com (`https://railway.com/project/{project}/service/<its serviceId>?id=<its id>`); no `steps`",
        cli: "`railway deployment list --service {service} --environment {environment|production} --limit 20 --json`, in a checkout linked to project `{project}` (`railway status --json` names it; link it with `railway link --project {project}` when it doesn't): the deployment whose commit (`meta.commitHash`) is <sha>: none is `none`; its `status` read as the MCP variant says, `url` likewise; no `steps`",
        api: '`curl -fsSL https://backboard.railway.com/graphql/v2 -H "Authorization: Bearer {token}" -H "Content-Type: application/json" -d \'{"query":"query($p: String!, $s: String, $e: String) { deployments(first: 20, input: { projectId: $p, serviceId: $s, environmentId: $e }) { edges { node { id serviceId status meta } } } }","variables":{"p":"{project}","s":"<service id>","e":"<environment id>"}}\'`, the ids of service `{service}` and environment `{environment|production}` (an entry may name them; `project(id:)`\'s `services` and `environments` map names to ids). A response with `errors` failed. The node whose `meta.commitHash` is <sha>: none is `none`; its `status` and `url` read as the MCP variant says; no `steps`',
      },
    },
  },
  detect(ctx) {
    const evidence: string[] = []
    const instances: SectionValues[] = []
    const names: { preferred: string; fallback: string }[] = []
    for (const file of ctx.tracked.filter((f) => CONFIG_FILE.test(f))) {
      evidence.push(`${file} (Railway config as code)`)
      const dir = path.dirname(file) === "." ? "" : path.dirname(file)
      names.push({
        preferred: dir === "" ? "root" : path.basename(dir),
        fallback: dir === "" ? "root" : dir,
      })
      instances.push(dir !== "" ? { directory: dir } : {})
    }
    for (const { file, text } of ctx.envTemplates) {
      if (/RAILWAY_|\.railway\.(app|internal)/.test(text)) {
        evidence.push(`${file} mentions Railway`)
      }
    }
    if (evidence.length === 0) {
      return undefined
    }
    const unique = uniqueInstanceNames(names)
    const detection: Detection = {
      values: instances[0] ?? {},
      ...(instances.length > 1
        ? { instances: instances.map((v, i) => ({ name: unique[i], ...v })) }
        : {}),
      evidence,
    }
    return detection
  },
}

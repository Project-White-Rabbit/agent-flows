// Where an integration's adapters come from: the plugin's built-in ones
// (`IntegrationSpec.adapters`), and the repo's own in
// `.agent-flows/adapters/<integration>.ts`, which add ops or replace built-in
// ones. A repo adapter is the team's code, run like any other repo script.
//
// Runtime code: Node built-ins only.

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { CAPABILITIES } from "../capabilities.ts"
import type { Adapter, IntegrationSpec } from "../types.ts"

export const ADAPTERS_DIR = ".agent-flows/adapters"

export type LoadedAdapter = { adapter: Adapter; source: "plugin" | "repo" }

export type LoadedAdapters = {
  adapters: Record<string, LoadedAdapter>
  /** Problems with the repo's adapter file; its adapters are then ignored. */
  issues: string[]
}

function integrationId(spec: IntegrationSpec): string {
  return spec.path.split(".").at(-1) as string
}

/** Every op name the integration's capabilities declare. */
function opsOf(spec: IntegrationSpec): string[] {
  return Object.keys(spec.provides).flatMap((id) =>
    Object.keys(CAPABILITIES.find((c) => c.id === id)?.ops ?? {}),
  )
}

export function adapterFile(root: string, spec: IntegrationSpec): string {
  return path.join(root, ADAPTERS_DIR, `${integrationId(spec)}.ts`)
}

function isAdapter(value: unknown): value is Adapter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Adapter).run === "function"
  )
}

export async function loadAdapters(
  root: string,
  spec: IntegrationSpec,
): Promise<LoadedAdapters> {
  const adapters: Record<string, LoadedAdapter> = {}
  for (const [op, adapter] of Object.entries(spec.adapters ?? {})) {
    adapters[op] = { adapter, source: "plugin" }
  }
  const file = adapterFile(root, spec)
  if (!fs.existsSync(file)) {
    return { adapters, issues: [] }
  }
  const where = path.relative(root, file)
  let mod: { adapters?: unknown }
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (error) {
    return {
      adapters,
      issues: [
        `${where} failed to load: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }
  if (typeof mod.adapters !== "object" || mod.adapters === null) {
    return {
      adapters,
      issues: [`${where} must export \`adapters\`: { <op>: { run(input) } }`],
    }
  }
  const known = opsOf(spec)
  const issues: string[] = []
  for (const [op, adapter] of Object.entries(mod.adapters)) {
    if (!known.includes(op)) {
      issues.push(
        `${where}: ${spec.name} has no op \`${op}\` (its ops: ${known.join(", ")})`,
      )
    } else if (!isAdapter(adapter)) {
      issues.push(
        `${where}: \`${op}\` must be an object with a \`run\` function`,
      )
    } else {
      adapters[op] = { adapter, source: "repo" }
    }
  }
  return { adapters, issues }
}

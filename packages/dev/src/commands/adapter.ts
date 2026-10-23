// Runs an integration's adapter: an op as code (see `Adapter`), from the
// plugin or the repo's `.agent-flows/adapters/<integration>.ts`. Skills reach
// it through the op's `script` variant, which `configure.ts integrations`
// writes out in full.

import { probeAccess, systemProbe } from "../config/access.ts"
import { loadAdapters } from "../config/adapters/index.ts"
import { getAt, INSTANCE_KEY, instancesOf } from "../config/config.ts"
import { INTEGRATIONS } from "../config/sections/index.ts"
import { usesOf, withoutUse } from "../config/use.ts"
import { loadConfig, NOT_CONFIGURED_EXIT, repoRoot } from "./configure.ts"
import { isMain, printJson, runMain } from "./lib.ts"

/** Exit code for an adapter that can't run on this machine. */
export const UNAVAILABLE_EXIT = 3

function unavailable(reason: string): void {
  printJson({ available: false, reason })
  process.exitCode = UNAVAILABLE_EXIT
}

const USAGE = `Usage: adapter.ts run <integration> <op> [--instance <name>] [--<arg> <value>]...

Runs the integration's adapter for <op> against its entry in
.agent-flows/config.json, and prints what it returns as JSON. The repo's
.agent-flows/adapters/<integration>.ts replaces a built-in adapter for the
same op. Exits ${NOT_CONFIGURED_EXIT} when the integration isn't configured, ${UNAVAILABLE_EXIT} when the adapter
can't run here (no adapter, or its token or CLI is missing), 1 on an error.`

export async function main(argv: string[]): Promise<void> {
  const [command, integration, op, ...rest] = argv
  if (command !== "run" || !integration || !op) {
    console.log(USAGE)
    process.exitCode = command === "help" || !command ? 0 : 1
    return
  }
  const args: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].startsWith("--") ? rest[i].slice(2) : undefined
    const value = rest[i + 1]
    if (!name || value === undefined) {
      throw new Error(`expected --<name> <value>, got \`${rest[i]}\``)
    }
    args[name] = value
    i++
  }
  const instance = args.instance
  delete args.instance

  const spec = INTEGRATIONS.find(
    (s) => s.path === `integrations.${integration}`,
  )
  if (!spec) {
    throw new Error(
      `unknown integration \`${integration}\` (known: ${INTEGRATIONS.map((s) => s.path.split(".").at(-1)).join(", ")})`,
    )
  }
  const root = repoRoot()
  const loaded = loadConfig(root)
  const entry = loaded.config ? getAt(loaded.config, spec.path) : undefined
  const instances = instancesOf(entry)
  const values = instance
    ? instances.find((v) => v[INSTANCE_KEY] === instance)
    : instances.length === 1
      ? instances[0]
      : undefined
  if (!values) {
    printJson({
      configured: false,
      message: instance
        ? `${spec.path} has no instance \`${instance}\`.`
        : instances.length > 1
          ? `${spec.path} is configured more than once: pass --instance <name>.`
          : `${spec.path} isn't configured. Run the agent-flows configure command first.`,
    })
    process.exitCode = NOT_CONFIGURED_EXIT
    return
  }
  const capability = Object.keys(spec.provides).find((id) =>
    Object.keys(spec.provides[id]).includes(op),
  )
  if (capability && usesOf(spec, values)[capability] === undefined) {
    printJson({
      configured: false,
      message: `The team doesn't use ${spec.name} for ${capability} (its \`use\` leaves it out).`,
    })
    process.exitCode = NOT_CONFIGURED_EXIT
    return
  }

  const { adapters, issues } = await loadAdapters(root, spec)
  for (const issue of issues) {
    console.error(`warning: ${issue}`)
  }
  const found = adapters[op]
  if (!found) {
    unavailable(`${spec.name} has no adapter for \`${op}\``)
    return
  }
  const { adapter } = found
  const missing = (adapter.args ?? []).filter((a) => args[a] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `\`${op}\` needs ${missing.map((a) => `--${a} <${a}>`).join(" ")}`,
    )
  }
  const report = await probeAccess(spec.access, systemProbe())
  let token: string | undefined
  if (adapter.needs === "api") {
    if (!report.api?.ready) {
      unavailable(
        `${spec.name}'s adapter needs an API token: set ${spec.access.api?.token.join(" or ") ?? "its token variable"}`,
      )
      return
    }
    token = process.env[report.api.token]
  } else if (adapter.needs === "cli" && !report.cli?.ready) {
    unavailable(
      `${spec.name}'s adapter needs its CLI: install \`${spec.access.cli?.bin}\` and sign in${report.cli?.auth ? ` (\`${report.cli.auth}\`)` : ""}`,
    )
    return
  }
  printJson(
    await adapter.run({
      values: withoutUse(values),
      args,
      token,
      fetch: globalThis.fetch,
    }),
  )
}

if (isMain(import.meta.filename)) {
  runMain(() => main(process.argv.slice(2)))
}

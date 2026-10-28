// Which ways of reaching an integration work on this machine. The CLI and the
// API are checked here; MCP servers live in the agent's session, where only
// the agent can see them, so they're reported for it to check.
//
// Runtime code: Node built-ins only.

import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import {
  describeSource,
  sourceReady,
  type TokenSource,
  tokenExpression,
} from "./local.ts"
import type { AccessSpec, IntegrationSpec } from "./types.ts"

export type AccessReport = {
  /** Usable when the agent has tools from this server. */
  mcp?: { server: string }
  cli?: {
    bin: string
    installed: boolean
    /** Signed in (or needs no sign-in). False when not installed. */
    ready: boolean
    /** The sign-in check, for telling the user how to fix it. */
    auth?: string
  }
  api?: {
    base: string
    /**
     * Where the token comes from, never its value: the source configure
     * recorded for this machine (`file /path`), else the first of the
     * integration's variables that's set, else the first named.
     */
    source: string
    /** True when configure recorded it; false for a guessed variable. */
    configured: boolean
    /** The token as a shell expression, which ops splice in as `{token}`. */
    expression: string
    ready: boolean
  }
}

export type Probe = {
  /** Absolute path of `bin` on PATH, or undefined. */
  which(bin: string): string | undefined
  /** Whether `command` exits 0, within a time limit. Output is discarded. */
  succeeds(command: string[]): Promise<boolean>
  env: Record<string, string | undefined>
}

export function systemProbe(env = process.env): Probe {
  return {
    which(bin) {
      for (const dir of (env.PATH ?? "").split(path.delimiter)) {
        if (!dir) {
          continue
        }
        const candidate = path.join(dir, bin)
        try {
          fs.accessSync(candidate, fs.constants.X_OK)
          return candidate
        } catch {
          // Not here.
        }
      }
      return undefined
    },
    succeeds(command) {
      return new Promise((resolve) => {
        // A sign-in check can hit the network; never let one hang configure.
        execFile(
          command[0],
          command.slice(1),
          { env, timeout: 10_000 },
          (error) => resolve(!error),
        )
      })
    },
    env,
  }
}

export async function probeAccess(
  access: AccessSpec,
  probe: Probe,
  /** Where configure recorded this integration's token, on this machine. */
  token?: TokenSource,
): Promise<AccessReport> {
  const report: AccessReport = {}
  if (access.mcp) {
    report.mcp = { server: access.mcp.server }
  }
  if (access.cli) {
    const { bin, auth } = access.cli
    const installed = probe.which(bin) !== undefined
    const ready = installed && (!auth || (await probe.succeeds(auth)))
    report.cli = {
      bin,
      installed,
      ready,
      ...(auth ? { auth: auth.join(" ") } : {}),
    }
  }
  if (access.api) {
    const source: TokenSource = token ?? {
      env:
        access.api.token.find((name) => probe.env[name]) ?? access.api.token[0],
    }
    report.api = {
      base: access.api.base,
      source: describeSource(source),
      configured: token !== undefined,
      expression: tokenExpression(source),
      ready: sourceReady(source, probe.env),
    }
  }
  return report
}

/** The key an instance's own report is under: `integrations.linear:<instance>`. */
export function accessKey(sectionPath: string, instance?: string): string {
  return instance ? `${sectionPath}:${instance}` : sectionPath
}

/**
 * Every integration's report, probed in parallel, by section path; and, for
 * an instance with a token of its own (`linear:<instance>`), by
 * `accessKey(path, instance)` too.
 */
export async function probeAll(
  specs: IntegrationSpec[],
  probe: Probe,
  /** Recorded token sources, by integration id (`linear`) or instance (`linear:<name>`). */
  tokens: Record<string, TokenSource> = {},
): Promise<Record<string, AccessReport>> {
  const targets: [string, IntegrationSpec, TokenSource | undefined][] = []
  for (const spec of specs) {
    const id = spec.path.split(".").at(-1) as string
    targets.push([spec.path, spec, tokens[id]])
    for (const [key, source] of Object.entries(tokens)) {
      if (key.startsWith(`${id}:`)) {
        targets.push([
          accessKey(spec.path, key.slice(id.length + 1)),
          spec,
          source,
        ])
      }
    }
  }
  const reports = await Promise.all(
    targets.map(([, spec, source]) => probeAccess(spec.access, probe, source)),
  )
  return Object.fromEntries(targets.map(([key], i) => [key, reports[i]]))
}

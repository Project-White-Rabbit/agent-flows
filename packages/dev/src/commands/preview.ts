// The mechanical half of preview: find the dev server this checkout already
// runs, or start one and wait until it answers. Which page to open, and where,
// stays in the skill.
//
// A server preview starts is recorded in the worktree's own git dir, so each
// worktree has its own, and `stop` stops only that one: never a server someone
// started by hand, or another checkout's.

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { getAt } from "../config/config.ts"
import { loadConfig, repoRoot } from "./configure.ts"
import {
  isMain,
  parseFlags,
  printJson,
  run,
  stateDir,
  USAGE_EXIT,
  UsageError,
} from "./lib.ts"

export type Listener = {
  pid: number
  port: number
  /** The process's working directory, when it could be read. */
  cwd?: string
  /** Its command line, when it could be read. */
  command?: string
}

export type ServerState = {
  pid: number
  command: string
  /** The URL it serves, once known. */
  url: string | null
  log: string
  startedAt: string
}

export type ServerResult = {
  /**
   * `running`: this checkout's server answers (`started` false: one preview
   * didn't start, or started on an earlier run). `started`: preview started it
   * now. `elsewhere`: the configured URL answers, but another checkout's
   * server serves it. `stopped`: none runs (`--check`). `unconfigured`: none
   * runs, and there's no command to start one. `failed`: the command exited
   * before it served. `timeout`: it still hadn't answered when time ran out,
   * and goes on running.
   */
  status:
    | "running"
    | "started"
    | "elsewhere"
    | "stopped"
    | "unconfigured"
    | "failed"
    | "timeout"
  /** Where it serves; null when it isn't known (several servers, or none). */
  url: string | null
  /** This checkout's servers listening now, for a choice when there are several. */
  servers: Listener[]
  /** Whether preview started the server (now, or on an earlier run). */
  ours: boolean
  pid?: number
  command?: string
  log?: string
  /** The process serving the configured URL, for `elsewhere`. */
  owner?: Listener
  exitCode?: number | null
  /** The log's last lines, for `failed` and `timeout`. */
  tail?: string
}

export type Settings = {
  command: string | null
  url: string | null
  /** Seconds to wait for a started server to answer. */
  timeout: number
}

export const DEFAULT_TIMEOUT = 120

// Terminal color codes: ESC [ … final byte.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const URL_IN_LOG =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+(?:\.[\w-]+)*):\d{2,5}(?:\/[^\s'"`<>)\]]*)?/g

/**
 * The URL a dev server printed that it serves on: the first local one (a
 * `Local:` line, as Vite and Next print, before a `Network:` one), else the
 * first. `0.0.0.0` and `[::]` mean every interface, so they read as localhost.
 */
export function urlFromLog(text: string): string | undefined {
  const found = [...text.replace(ANSI, "").matchAll(URL_IN_LOG)].map((m) =>
    m[0]
      .replace(/[.,;:]+$/, "")
      .replace(/\/\/(?:0\.0\.0\.0|\[::\])(?=:)/, "//localhost"),
  )
  return (
    found.find((url) => /\/\/(?:localhost|127\.0\.0\.1|\[::1\])/.test(url)) ??
    found[0]
  )
}

/** `lsof -F pn` output as each process and the TCP ports it listens on. */
export function parseLsof(output: string): Listener[] {
  const out: Listener[] = []
  let pid: number | undefined
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1))
    } else if (line.startsWith("n") && pid !== undefined) {
      const port = Number(/:(\d+)$/.exec(line)?.[1])
      if (port > 0 && !out.some((l) => l.pid === pid && l.port === port)) {
        out.push({ pid, port })
      }
    }
  }
  return out
}

/** `lsof -F pn` cwd output as each process's working directory. */
export function parseCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | undefined
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1))
    } else if (line.startsWith("n") && pid !== undefined) {
      cwds.set(pid, line.slice(1))
    }
  }
  return cwds
}

/** Every TCP listener on this machine, with its working directory and command. */
function systemListeners(): Listener[] {
  const listening = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
  if (listening.status === null) {
    return []
  }
  const found = parseLsof(listening.stdout)
  const pids = [...new Set(found.map((l) => l.pid))]
  if (pids.length === 0) {
    return []
  }
  const cwds = parseCwds(
    run("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")]).stdout,
  )
  return found.map((l) => {
    const command = run("ps", ["-o", "command=", "-p", String(l.pid)])
      .stdout.trim()
      .slice(0, 300)
    const cwd = cwds.get(l.pid)
    return {
      ...l,
      ...(cwd ? { cwd } : {}),
      ...(command ? { command } : {}),
    }
  })
}

function inside(dir: string | undefined, root: string): boolean {
  return dir !== undefined && (dir === root || dir.startsWith(`${root}/`))
}

function portOf(url: string): number | undefined {
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port)
    if (port > 0) {
      return port
    }
    return parsed.protocol === "https:" ? 443 : 80
  } catch {
    return undefined
  }
}

/** `url` served on `port` instead, keeping its host, path, and protocol. */
function onPort(url: string | null, port: number): string {
  if (!url) {
    return `http://localhost:${port}`
  }
  const parsed = new URL(url)
  parsed.port = String(port)
  return parsed.toString()
}

/** Whether anything answers at `url`, whatever the status. */
export async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    })
    return true
  } catch {
    return false
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export type Deps = {
  root: string
  state: ServerState | undefined
  listeners(): Listener[]
  answers(url: string): Promise<boolean>
  alive(pid: number): boolean
}

/**
 * Whether a server already serves this checkout, without starting one:
 * `undefined` when none does (and nothing else holds the configured URL).
 */
export async function findServer(
  settings: Settings,
  deps: Deps,
): Promise<ServerResult | undefined> {
  const all = deps.listeners()
  const servers = all.filter((l) => inside(l.cwd, deps.root))
  const { state } = deps
  const ours = state !== undefined && deps.alive(state.pid)
  const recorded = ours
    ? {
        ours: true,
        pid: state.pid,
        command: state.command,
        log: state.log,
      }
    : { ours: false }

  // The one preview started, while it still answers where it said it would.
  if (ours && state.url && (await deps.answers(state.url))) {
    return { status: "running", url: state.url, servers, ...recorded }
  }
  const wanted = settings.url ? portOf(settings.url) : undefined
  const pick =
    servers.find((l) => l.port === wanted) ??
    (servers.length === 1 ? servers[0] : undefined) ??
    // Several: the one preview started, when it's among them.
    (ours ? servers.find((l) => l.pid === state.pid) : undefined)
  if (pick) {
    return {
      status: "running",
      url: onPort(settings.url, pick.port),
      servers,
      ...recorded,
    }
  }
  if (servers.length > 1) {
    return { status: "running", url: null, servers, ...recorded }
  }
  if (settings.url && (await deps.answers(settings.url))) {
    const owner = all.find((l) => l.port === wanted)
    // Whose it is can't be told (no lsof): take it as this checkout's.
    if (!owner?.cwd) {
      return { status: "running", url: settings.url, servers, ...recorded }
    }
    return {
      status: "elsewhere",
      url: settings.url,
      servers,
      owner,
      ours: false,
    }
  }
  return undefined
}

function tail(file: string, lines = 30): string {
  try {
    return fs
      .readFileSync(file, "utf8")
      .replace(ANSI, "")
      .split("\n")
      .slice(-lines)
      .join("\n")
      .trim()
  } catch {
    return ""
  }
}

export function readState(dir: string): ServerState | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8"))
  } catch {
    return undefined
  }
}

function writeState(dir: string, state: ServerState): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "server.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Start `settings.command` in the background and wait until it answers. */
export async function start(
  root: string,
  dir: string,
  settings: Settings & { command: string },
): Promise<ServerResult> {
  fs.mkdirSync(dir, { recursive: true })
  const log = path.join(dir, "server.log")
  const out = fs.openSync(log, "w")
  // Its own process group, so `stop` stops what it spawns too, and it outlives
  // this command.
  const child = spawn("sh", ["-c", settings.command], {
    cwd: root,
    detached: true,
    stdio: ["ignore", out, out],
  })
  fs.closeSync(out)
  let exit: number | null | undefined
  child.on("exit", (code) => {
    exit = code
  })
  child.on("error", () => {
    exit = exit ?? -1
  })
  child.unref()
  const pid = child.pid as number
  const state: ServerState = {
    pid,
    command: settings.command,
    url: null,
    log,
    startedAt: new Date().toISOString(),
  }
  writeState(dir, state)
  const base = { ours: true, pid, command: settings.command, log }

  const deadline = Date.now() + settings.timeout * 1000
  while (Date.now() < deadline) {
    await sleep(500)
    if (exit !== undefined) {
      fs.rmSync(path.join(dir, "server.json"), { force: true })
      return {
        status: "failed",
        url: null,
        servers: [],
        ...base,
        ours: false,
        exitCode: exit,
        tail: tail(log),
      }
    }
    let url = settings.url ?? urlFromLog(tail(log, 200)) ?? null
    if (!url) {
      // It printed no URL: whatever this checkout now listens on.
      const mine = systemListeners().filter((l) => inside(l.cwd, root))
      if (mine.length === 1) {
        url = onPort(null, (mine[0] as Listener).port)
      }
    }
    if (url && (await answers(url))) {
      writeState(dir, { ...state, url })
      const servers = systemListeners().filter((l) => inside(l.cwd, root))
      return { status: "started", url, servers, ...base }
    }
  }
  return {
    status: "timeout",
    url: settings.url,
    servers: [],
    ...base,
    tail: tail(log),
  }
}

/** Stop the server recorded in `dir`, which `flow` started. */
export async function stop(
  dir: string,
  flow = "preview",
): Promise<{ stopped: boolean; pid?: number; reason?: string }> {
  const state = readState(dir)
  if (!state || !alive(state.pid)) {
    fs.rmSync(path.join(dir, "server.json"), { force: true })
    return { stopped: false, reason: `no server ${flow} started is running` }
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-state.pid, sig)
    } catch {
      try {
        process.kill(state.pid, sig)
      } catch {
        // Gone already.
      }
    }
  }
  signal("SIGTERM")
  for (let i = 0; i < 20 && alive(state.pid); i++) {
    await sleep(250)
  }
  if (alive(state.pid)) {
    signal("SIGKILL")
  }
  fs.rmSync(path.join(dir, "server.json"), { force: true })
  return { stopped: true, pid: state.pid }
}

function settingsOf(root: string, flags: Map<string, string>): Settings {
  const config = loadConfig(root).config ?? {}
  const str = (key: string) => {
    const value = getAt(config, `preview.${key}`)
    return typeof value === "string" && value ? value : null
  }
  const timeout = Number(
    flags.get("timeout") ?? getAt(config, "preview.timeout") ?? DEFAULT_TIMEOUT,
  )
  if (!(timeout > 0)) {
    throw new UsageError("--timeout must be a number of seconds above 0")
  }
  const url = flags.get("url") ?? str("url")
  if (url) {
    try {
      new URL(url)
    } catch {
      throw new UsageError(`not a URL: ${url}`)
    }
  }
  return { command: flags.get("command") ?? str("command"), url, timeout }
}

const USAGE = `Usage: preview.ts <subcommand>

  server [--command <cmd>] [--url <url>] [--timeout <seconds>] [--check]
                     Find the dev server this checkout runs, or start one in
                     the background (preview.command, its output in a log in
                     the git dir) and wait until it answers. Prints its url
                     and status. --check only looks. --command and --url
                     stand in for preview.command and preview.url
  stop               Stop the server preview started in this worktree`

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  if (command !== "server" && command !== "stop") {
    console.log(USAGE)
    process.exitCode = command && command !== "help" ? 1 : 0
    return
  }
  try {
    const flags = parseFlags(rest, new Set(["check"]))
    const root = fs.realpathSync(repoRoot())
    const dir = stateDir("preview", { cwd: root })
    if (command === "stop") {
      printJson(await stop(dir))
      return
    }
    const settings = settingsOf(root, flags)
    const found = await findServer(settings, {
      root,
      state: readState(dir),
      listeners: systemListeners,
      answers,
      alive,
    })
    if (found) {
      printJson(found)
      return
    }
    if (flags.has("check")) {
      printJson({ status: "stopped", url: null, servers: [], ours: false })
      return
    }
    if (!settings.command) {
      printJson({ status: "unconfigured", url: null, servers: [], ours: false })
      return
    }
    const result = await start(root, dir, {
      ...settings,
      command: settings.command,
    })
    printJson(result)
    if (result.status === "failed" || result.status === "timeout") {
      process.exitCode = 1
    }
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error
    }
    console.error(error.message)
    process.exitCode = USAGE_EXIT
  }
}

if (isMain(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

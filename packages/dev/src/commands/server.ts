// A worktree's dev server, from start to stop: find the one this checkout
// already runs, or start one and wait until it answers; stop it; and make sure
// none is left running that nothing needs. Which page to open, and where, is
// preview's.
//
// Each server dev-flows starts runs under a watchdog (`watch`, this same
// script) that stops it once its worktree is deleted, or once nothing has been
// connected to it for `server.idleTimeout` minutes (an open page keeps its
// live-reload socket open, so a page someone has open counts as in use).
//
// The servers dev-flows starts are recorded in the repo's common git dir, one
// per worktree, so a server stays known after its worktree is deleted: every
// run stops the ones whose worktree is gone, and `stop --all` stops them all.
// `stop` stops only this worktree's: never a server someone started by hand,
// or another checkout's. `adopt` restarts one started by hand under the
// watchdog, when the person says so.

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
  /** Whether it runs under the watchdog (older versions started it bare). */
  watched?: boolean
}

/** A process, as `ps` lists it. */
export type Proc = { pid: number; ppid: number; command: string }

/** The servers dev-flows started, by the worktree each serves. */
export type Registry = Record<string, ServerState>

/** A server dev-flows started, stopped because nothing needs it any more. */
export type Reaped = {
  worktree: string
  pid: number
  command: string
}

export type ServerResult = {
  /**
   * `running`: this checkout's server answers (`started` false: one dev-flows
   * didn't start, or started on an earlier run). `started`: dev-flows started it
   * now. `elsewhere`: the configured URL answers, but another checkout's
   * server serves it. `stopped`: none runs (`status`). `unconfigured`: none
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
  /** Whether dev-flows started the server (now, or on an earlier run). */
  ours: boolean
  /**
   * Whether the server runs under the watchdog, which stops it once its
   * worktree is deleted or it sits idle. False for one started by hand, or by
   * an older dev-flows: `adopt` restarts it under one.
   */
  watched?: boolean
  pid?: number
  command?: string
  log?: string
  /** The process serving the configured URL, for `elsewhere`. */
  owner?: Listener
  exitCode?: number | null
  /** The log's last lines, for `failed` and `timeout`. */
  tail?: string
  /** Servers dev-flows started for worktrees that are gone, stopped now. */
  reaped?: Reaped[]
}

export type Settings = {
  command: string | null
  url: string | null
  /** Seconds to wait for a started server to answer. */
  timeout: number
  /** Minutes with nothing connected before the watchdog stops it; 0: never. */
  idleTimeout: number
}

export const DEFAULT_TIMEOUT = 120
export const DEFAULT_IDLE_MINUTES = 240
/** How often the watchdog looks, in milliseconds. */
const WATCH_INTERVAL = 30_000

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
async function answers(url: string): Promise<boolean> {
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

function signalOk(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Whether anything dev-flows started under `pid` still runs: the shell it
 * started, or anything in its process group (a dev server can outlive the
 * shell that started it).
 */
function groupAlive(pid: number): boolean {
  if (process.platform === "win32") {
    return signalOk(pid)
  }
  return signalOk(-pid) || signalOk(pid)
}

/** `ps` elapsed time (`[[dd-]hh:]mm:ss`) in seconds. */
export function parseEtime(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim())
  if (!match) {
    return undefined
  }
  const [, d = "0", h = "0", m = "0", s = "0"] = match
  return ((Number(d) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(s)
}

/** Seconds since `pid` started, when `ps` can tell. */
function elapsed(pid: number): number | undefined {
  const out = run("ps", ["-o", "etime=", "-p", String(pid)])
  return out.status === 0 ? parseEtime(out.stdout) : undefined
}

/**
 * Whether the server `state` records still runs as the one dev-flows started.
 * A process with its pid that started at another time is a stranger that got
 * the pid after it ended, and is never ours to stop.
 */
export function running(
  state: ServerState,
  probe: {
    groupAlive(pid: number): boolean
    elapsed(pid: number): number | undefined
    now: number
  } = { groupAlive, elapsed, now: Date.now() },
): boolean {
  if (!probe.groupAlive(state.pid)) {
    return false
  }
  const seconds = probe.elapsed(state.pid)
  if (seconds === undefined) {
    // The shell is gone and only its group runs (a pid isn't reused while its
    // group lives), or there's no ps to ask.
    return true
  }
  const started = probe.now - seconds * 1000
  return Math.abs(started - Date.parse(state.startedAt)) < 120_000
}

export type Deps = {
  root: string
  state: ServerState | undefined
  listeners(): Listener[]
  answers(url: string): Promise<boolean>
  running(state: ServerState): boolean
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
  const ours = state !== undefined && deps.running(state)
  const recorded = ours
    ? {
        ours: true,
        watched: state.watched === true,
        pid: state.pid,
        command: state.command,
        log: state.log,
      }
    : { ours: false, watched: false }

  // The one dev-flows started, while it still answers where it said it would.
  if (ours && state.url && (await deps.answers(state.url))) {
    return { status: "running", url: state.url, servers, ...recorded }
  }
  const wanted = settings.url ? portOf(settings.url) : undefined
  const pick =
    servers.find((l) => l.port === wanted) ??
    (servers.length === 1 ? servers[0] : undefined) ??
    // Several: the one dev-flows started, when it's among them.
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
      watched: false,
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

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

function readRegistry(dir: string): Registry {
  return readJson<Registry>(path.join(dir, "servers.json")) ?? {}
}

/** Change the registry: read it fresh, so other worktrees' runs aren't lost. */
function updateRegistry(dir: string, change: (registry: Registry) => void) {
  fs.mkdirSync(dir, { recursive: true })
  const registry = readRegistry(dir)
  change(registry)
  const file = path.join(dir, "servers.json")
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`)
  fs.renameSync(temp, file)
}

/**
 * A worktree's server as an earlier version recorded it, in the worktree's own
 * git dir: moved into the registry, so it isn't lost when the worktree is.
 */
function migrateLegacy(dir: string, root: string, legacyDir: string): void {
  const file = path.join(legacyDir, "server.json")
  const legacy = readJson<ServerState>(file)
  if (legacy) {
    updateRegistry(dir, (registry) => {
      registry[root] ??= legacy
    })
  }
  fs.rmSync(file, { force: true })
}

/** The log file for a worktree's server, named after its path. */
function logFile(dir: string, root: string): string {
  const name = root.replace(/^\/+/, "").replace(/[^\w.-]+/g, "-")
  return path.join(dir, "logs", `${name.slice(-120)}.log`)
}

/** This repo's worktrees, or undefined when git can't list them. */
function worktrees(root: string): Set<string> | undefined {
  const out = run("git", ["worktree", "list", "--porcelain"], root)
  if (out.status !== 0) {
    return undefined
  }
  const found = new Set<string>()
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      const dir = line.slice("worktree ".length)
      try {
        found.add(fs.realpathSync(dir))
      } catch {
        // Gone from disk, though git still lists it until it's pruned.
      }
    }
  }
  return found
}

/**
 * Sort the registry: the servers that still run for a worktree that's still
 * here stay; the ones whose worktree is gone are `orphans`, to stop; the ones
 * that no longer run are dropped. With no list of worktrees, nothing is an
 * orphan: a failed read is not an absence.
 */
export function sweep(
  registry: Registry,
  live: Set<string> | undefined,
  isRunning: (state: ServerState) => boolean,
): { kept: Registry; orphans: [string, ServerState][] } {
  const kept: Registry = {}
  const orphans: [string, ServerState][] = []
  for (const [worktree, state] of Object.entries(registry)) {
    if (!isRunning(state)) {
      continue
    }
    if (live && !live.has(worktree)) {
      orphans.push([worktree, state])
    } else {
      kept[worktree] = state
    }
  }
  return { kept, orphans }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Start `settings.command` in the background and wait until it answers. */
async function start(
  root: string,
  dir: string,
  settings: Settings & { command: string },
): Promise<ServerResult> {
  const log = logFile(dir, root)
  fs.mkdirSync(path.dirname(log), { recursive: true })
  const out = fs.openSync(log, "w")
  // The watchdog, which runs the command: in its own process group, so `stop`
  // stops what it spawns too, and it outlives this command.
  const child = spawn(
    process.execPath,
    [
      import.meta.filename,
      "watch",
      "--root",
      root,
      "--idle",
      String(settings.idleTimeout),
      "--command",
      settings.command,
    ],
    { cwd: root, detached: true, stdio: ["ignore", out, out] },
  )
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
    watched: true,
  }
  updateRegistry(dir, (registry) => {
    registry[root] = state
  })
  const base = {
    ours: true,
    watched: true,
    pid,
    command: settings.command,
    log,
  }

  const deadline = Date.now() + settings.timeout * 1000
  while (Date.now() < deadline) {
    await sleep(500)
    if (exit !== undefined) {
      updateRegistry(dir, (registry) => {
        delete registry[root]
      })
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
      updateRegistry(dir, (registry) => {
        registry[root] = { ...state, url }
      })
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

/** Stop a server dev-flows started, and everything in its process group. */
async function kill(state: ServerState): Promise<void> {
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
  for (let i = 0; i < 20 && groupAlive(state.pid); i++) {
    await sleep(250)
  }
  if (groupAlive(state.pid)) {
    signal("SIGKILL")
  }
}

/** Stop the servers dev-flows started for worktrees that are gone. */
async function reap(dir: string, root: string): Promise<Reaped[]> {
  const { orphans } = sweep(readRegistry(dir), worktrees(root), (s) =>
    running(s),
  )
  for (const [, state] of orphans) {
    await kill(state)
    fs.rmSync(state.log, { force: true })
  }
  // Drop what's stopped and what had already ended, keeping entries other
  // runs wrote meanwhile.
  updateRegistry(dir, (registry) => {
    for (const [worktree, state] of Object.entries(registry)) {
      if (!running(state)) {
        delete registry[worktree]
      }
    }
  })
  return orphans.map(([worktree, state]) => ({
    worktree,
    pid: state.pid,
    command: state.command,
  }))
}

async function stop(
  dir: string,
  root: string,
  all: boolean,
): Promise<{
  stopped: Reaped[]
  reason?: string
  reaped: Reaped[]
}> {
  const reaped = await reap(dir, root)
  const registry = readRegistry(dir)
  const targets = Object.entries(registry).filter(
    ([worktree]) => all || worktree === root,
  )
  for (const [, state] of targets) {
    await kill(state)
  }
  updateRegistry(dir, (fresh) => {
    for (const [worktree] of targets) {
      delete fresh[worktree]
    }
  })
  const stopped = targets.map(([worktree, state]) => ({
    worktree,
    pid: state.pid,
    command: state.command,
  }))
  return {
    stopped,
    ...(stopped.length === 0
      ? {
          reason: all
            ? "no server dev-flows started is running in this repo"
            : "no server dev-flows started is running in this worktree",
        }
      : {}),
    reaped,
  }
}

const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
])

/** Whether `command` runs a shell, interactive or running a script. */
export function isShell(command: string): boolean {
  const program = command.trim().split(/\s+/)[0] ?? ""
  return SHELLS.has(path.basename(program.replace(/^-/, "")))
}

/**
 * What stopping a server dev-flows didn't start takes: the tree under the
 * process that started it. From the process that listens, up through its
 * parents while they're part of the server (a package manager, a node, a
 * bundler), stopping below the first shell (a terminal's, a script's, or an
 * agent's tool) and below anything dev-flows itself runs under, so none of
 * those is ever stopped. Then that process and everything under it.
 */
export function adoptPlan(
  pid: number,
  procs: Proc[],
  self: number,
): { pids: number[] } | { refuse: string } {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const proc = byPid.get(pid)
  if (!proc) {
    return { refuse: `no process ${pid} is running` }
  }
  const mine = new Set<number>()
  for (let p = byPid.get(self); p && !mine.has(p.pid); p = byPid.get(p.ppid)) {
    mine.add(p.pid)
  }
  if (mine.has(pid) || isShell(proc.command)) {
    return { refuse: `process ${pid} isn't one dev-flows can stop safely` }
  }
  let top = proc
  for (;;) {
    const parent = byPid.get(top.ppid)
    if (
      !parent ||
      parent.pid <= 1 ||
      mine.has(parent.pid) ||
      isShell(parent.command)
    ) {
      break
    }
    top = parent
  }
  const pids = [top.pid]
  for (let i = 0; i < pids.length; i++) {
    for (const p of procs) {
      if (p.ppid === pids[i] && !mine.has(p.pid) && !pids.includes(p.pid)) {
        pids.push(p.pid)
      }
    }
  }
  return { pids }
}

function processes(): Proc[] {
  return run("ps", ["-A", "-o", "pid=,ppid=,command="])
    .stdout.split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      command: m[3] as string,
    }))
}

/**
 * Restart this checkout's server under the watchdog: stop the one dev-flows
 * started bare (an older version's), or the process `pid` that listens from
 * inside this checkout and the tree that started it (`adoptPlan`), then start
 * `settings.command` as `server` would.
 */
async function adopt(
  root: string,
  dir: string,
  settings: Settings & { command: string },
  pid: number | undefined,
): Promise<ServerResult & { replaced?: Reaped; reason?: string }> {
  const fail = (reason: string) => ({
    status: "failed" as const,
    url: null,
    servers: [],
    ours: false,
    reason,
  })
  const state = readRegistry(dir)[root]
  let replaced: Reaped
  if (state && running(state) && (pid === undefined || pid === state.pid)) {
    if (state.watched) {
      return fail("dev-flows already watches this checkout's server")
    }
    await kill(state)
    replaced = { worktree: root, pid: state.pid, command: state.command }
  } else {
    if (pid === undefined) {
      return fail("--pid <the server's pid> is required")
    }
    const listener = systemListeners().find(
      (l) => l.pid === pid && inside(l.cwd, root),
    )
    if (!listener) {
      return fail(`process ${pid} isn't a server listening from this checkout`)
    }
    const plan = adoptPlan(pid, processes(), process.pid)
    if ("refuse" in plan) {
      return fail(plan.refuse)
    }
    const signal = (sig: NodeJS.Signals) => {
      for (const target of plan.pids) {
        try {
          process.kill(target, sig)
        } catch {
          // Gone already.
        }
      }
    }
    const anyAlive = () => plan.pids.some((p) => signalOk(p))
    signal("SIGTERM")
    for (let i = 0; i < 40 && anyAlive(); i++) {
      await sleep(250)
    }
    if (anyAlive()) {
      signal("SIGKILL")
      await sleep(500)
    }
    replaced = {
      worktree: root,
      pid,
      command: listener.command ?? "",
    }
  }
  updateRegistry(dir, (registry) => {
    delete registry[root]
  })
  return { ...(await start(root, dir, settings)), replaced }
}

/**
 * What the watchdog does on a look: stop the server when its worktree is gone,
 * or when nothing has been connected to it for `idleMs` (0: never). Unknown
 * (no lsof, or nothing listening yet) counts as in use.
 */
export function watchVerdict(look: {
  rootExists: boolean
  connected: boolean | undefined
  lastActive: number
  now: number
  idleMs: number
}): "gone" | "idle" | undefined {
  if (!look.rootExists) {
    return "gone"
  }
  if (
    look.idleMs > 0 &&
    look.connected === false &&
    look.now - look.lastActive >= look.idleMs
  ) {
    return "idle"
  }
  return undefined
}

/**
 * Whether anything is connected to a port the process group `pgid` listens on:
 * undefined when it can't be told, or it listens on nothing yet.
 */
function groupConnected(pgid: number): boolean | undefined {
  const listening = run("lsof", [
    "-nP",
    "-a",
    "-g",
    String(pgid),
    "-iTCP",
    "-sTCP:LISTEN",
    "-Fpn",
  ])
  if (listening.status === null) {
    return undefined
  }
  const ports = [...new Set(parseLsof(listening.stdout).map((l) => l.port))]
  if (ports.length === 0) {
    return undefined
  }
  return ports.some((port) =>
    /^n/m.test(
      run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fn"]).stdout,
    ),
  )
}

/**
 * The watchdog: run `command` in this process group, pass on its exit, and
 * stop the whole group when `watchVerdict` says so.
 */
function watch(flags: Map<string, string>): void {
  const root = flags.get("root") ?? process.cwd()
  const command = flags.get("command")
  if (!command) {
    throw new UsageError("--command <cmd> is required")
  }
  const idleMs = Number(flags.get("idle") ?? DEFAULT_IDLE_MINUTES) * 60_000
  const child = spawn("sh", ["-c", command], { cwd: root, stdio: "inherit" })
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0))
  })
  child.on("error", () => process.exit(1))
  const killGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-process.pid, sig)
    } catch {
      child.kill(sig)
    }
  }
  let lastActive = Date.now()
  const timer = setInterval(() => {
    const connected = groupConnected(process.pid)
    const now = Date.now()
    if (connected !== false) {
      lastActive = now
    }
    const why = watchVerdict({
      rootExists: fs.existsSync(root),
      connected,
      lastActive,
      now,
      idleMs,
    })
    if (!why) {
      return
    }
    clearInterval(timer)
    console.log(
      why === "gone"
        ? `[server] stopping: the worktree ${root} is gone`
        : `[server] stopping: nothing connected for ${idleMs / 60_000} minutes`,
    )
    // Outlive the group's SIGTERM, to SIGKILL what ignores it.
    process.on("SIGTERM", () => {})
    killGroup("SIGTERM")
    setTimeout(() => killGroup("SIGKILL"), 10_000).unref()
  }, WATCH_INTERVAL)
}

function settingsOf(root: string, flags: Map<string, string>): Settings {
  const config = loadConfig(root).config ?? {}
  const str = (key: string) => {
    const value = getAt(config, `server.${key}`)
    return typeof value === "string" && value ? value : null
  }
  const timeout = Number(
    flags.get("timeout") ?? getAt(config, "server.timeout") ?? DEFAULT_TIMEOUT,
  )
  if (!(timeout > 0)) {
    throw new UsageError("--timeout must be a number of seconds above 0")
  }
  const idleTimeout = Number(
    getAt(config, "server.idleTimeout") ?? DEFAULT_IDLE_MINUTES,
  )
  if (!(idleTimeout >= 0)) {
    throw new UsageError("server.idleTimeout must be a number of minutes")
  }
  const url = flags.get("url") ?? str("url")
  if (url) {
    try {
      new URL(url)
    } catch {
      throw new UsageError(`not a URL: ${url}`)
    }
  }
  return {
    command: flags.get("command") ?? str("command"),
    url,
    timeout,
    idleTimeout,
  }
}

const USAGE = `Usage: server.ts <subcommand>

  start [--command <cmd>] [--url <url>] [--timeout <seconds>]
                     Find the dev server this checkout runs, or start one in
                     the background (server.command, its output in a log in
                     the git dir) and wait until it answers. Prints its url
                     and status. --command and --url stand in for
                     server.command and server.url
  status [--url <url>]
                     The same, only looking: starts nothing, stops nothing
  stop [--all]       Stop the server dev-flows started in this worktree (with
                     --all, every one it started in this repo's worktrees)
  list               The servers dev-flows started in this repo's worktrees
  adopt [--pid <pid>] [--command <cmd>] [--url <url>]
                     Restart this checkout's server under the watchdog: the
                     one an older dev-flows started, or process <pid> (a
                     server started by hand, listening from this checkout)
                     with the tree that started it, up to the shell it runs
                     in (never a shell, or what this runs under). Then starts
                     --command (else server.command) as start does

  Each run but status first stops the servers dev-flows started for worktrees
  that are gone, and prints them as reaped. Each server it starts runs under a
  watchdog that stops it once its worktree is deleted, or once nothing has
  been connected to it for server.idleTimeout minutes (default 240; 0: never).`

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  if (command === "watch") {
    try {
      watch(parseFlags(rest))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = USAGE_EXIT
    }
    return
  }
  if (
    command !== "start" &&
    command !== "status" &&
    command !== "stop" &&
    command !== "list" &&
    command !== "adopt"
  ) {
    console.log(USAGE)
    process.exitCode = command && command !== "help" ? 1 : 0
    return
  }
  try {
    const flags = parseFlags(rest, new Set(["all"]))
    const root = fs.realpathSync(repoRoot())
    const dir = stateDir("server", { cwd: root, shared: true })
    // Where preview kept the one server it started, before this command.
    migrateLegacy(dir, root, stateDir("preview", { cwd: root }))
    if (command === "stop") {
      printJson(await stop(dir, root, flags.has("all")))
      return
    }
    if (command === "list") {
      const reaped = await reap(dir, root)
      printJson({
        servers: Object.entries(readRegistry(dir)).map(([worktree, s]) => ({
          worktree,
          here: worktree === root,
          ...s,
        })),
        reaped,
      })
      return
    }
    const settings = settingsOf(root, flags)
    if (command === "adopt") {
      if (!settings.command) {
        throw new UsageError(
          "adopt needs --command <cmd> (or server.command) to restart the server with",
        )
      }
      const pid = flags.has("pid") ? Number(flags.get("pid")) : undefined
      if (pid !== undefined && !(pid > 1)) {
        throw new UsageError("--pid must be a process id")
      }
      const result = await adopt(
        root,
        dir,
        { ...settings, command: settings.command },
        pid,
      )
      printJson(result)
      if (result.status !== "started") {
        process.exitCode = 1
      }
      return
    }
    const looking = command === "status"
    const reaped = looking ? [] : await reap(dir, root)
    const extra = reaped.length > 0 ? { reaped } : {}
    const found = await findServer(settings, {
      root,
      state: readRegistry(dir)[root],
      listeners: systemListeners,
      answers,
      running: (s) => running(s),
    })
    if (found) {
      printJson({ ...found, ...extra })
      return
    }
    if (looking) {
      printJson({ status: "stopped", url: null, servers: [], ours: false })
      return
    }
    if (!settings.command) {
      printJson({
        status: "unconfigured",
        url: null,
        servers: [],
        ours: false,
        ...extra,
      })
      return
    }
    const result = await start(root, dir, {
      ...settings,
      command: settings.command,
    })
    printJson({ ...result, ...extra })
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

// The mechanical half of prototype, for a session that shows its mockups in a
// browser: a folder for the pages (by default a scratch one in the worktree's
// own git dir, so a mockup can't end up committed; `prototype.dir` when the
// team keeps its mockups in the repo), served over HTTP so a
// browser (and the agent's browser tools, which often refuse file:// pages)
// can open a mockup and reload it after each edit. What the mockup shows, and
// where the person sees it, stays in the skill.
//
// `prototype.index`, when set, is a Markdown file in the repo that keeps a
// record of each mockup: what it shows and the links that outlast the session
// (a hosted page such as a Claude artifact, a design link, the file kept in
// `prototype.dir`). `record` adds a mockup's entry or updates it in place, so
// a team that doesn't keep the pages themselves still keeps where they are.
//
// The server is this file run as `static`, started in the background and
// recorded beside the pages, so each worktree has its own and `stop` stops
// only that one. It stops itself once its folder is gone (the worktree was
// deleted) or nothing has asked it for a page in IDLE_MINUTES, so a mockup
// nobody stopped doesn't hold a port for good.

import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { getAt } from "../config/config.ts"
import { loadConfig, repoRoot } from "./configure.ts"
import {
  type Flags,
  isMain,
  parseFlags,
  printJson,
  requiredFlag,
  run,
  stateDir,
  USAGE_EXIT,
  UsageError,
} from "./lib.ts"

/** Seconds to wait for the static server to answer: it starts at once. */
const TIMEOUT = 15
/** Minutes with no request before the static server stops itself. */
const IDLE_MINUTES = 240

/**
 * The folder a worktree's mockup pages go in: `prototype.dir` inside the
 * checkout when the team keeps its mockups (`kept`), else the scratch folder
 * in the worktree's git dir. Undefined `dir` (or false) is the default.
 */
export function pagesDir(
  root: string,
  state: string,
  dir: unknown,
): { dir: string; kept: boolean } {
  if (typeof dir !== "string" || !dir) {
    return { dir: path.join(state, "pages"), kept: false }
  }
  const resolved = path.resolve(root, dir)
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new UsageError(
      `prototype.dir must be a folder inside the repo: ${dir}`,
    )
  }
  return { dir: resolved, kept: true }
}

/**
 * The Markdown file a worktree's mockups are recorded in: `prototype.index`
 * inside the checkout, or null when the team doesn't keep one.
 */
export function indexFile(root: string, index: unknown): string | null {
  if (typeof index !== "string" || !index) {
    return null
  }
  const resolved = path.resolve(root, index)
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new UsageError(
      `prototype.index must be a file inside the repo: ${index}`,
    )
  }
  return resolved
}

/** One mockup's entry in `prototype.index`. */
export type IndexEntry = {
  /** The mockup's kebab-case name, which keys its entry. */
  name: string
  title?: string
  summary?: string
  /** A hosted page that shows it (a Claude artifact, a canvas). */
  page?: string
  /** Where it is in the team's design tool. */
  design?: string
  /** The kept page, relative to the index file's folder. */
  file?: string
  branch?: string
  /** YYYY-MM-DD. */
  updated?: string
}

const INDEX_HEADER = `# Prototypes

UI mockups made with \`/dev-flows:prototype\`, newest first. Each entry links to where the mockup lives: a hosted page, the design tool, or the page kept in the repo. Entries are updated in place as a mockup changes; text outside them is left alone.
`

const FIELDS = [
  ["page", "Page"],
  ["design", "Design"],
  ["file", "File"],
] as const

function startMarker(name: string): string {
  return `<!-- prototype: ${name} -->`
}

function endMarker(name: string): string {
  return `<!-- /prototype: ${name} -->`
}

/** An entry's fields, read back from the block `renderEntry` wrote. */
export function parseEntry(name: string, block: string): IndexEntry {
  const entry: IndexEntry = { name }
  const lines = block.split("\n")
  const titleAt = lines.findIndex((l) => l.startsWith("### "))
  if (titleAt !== -1) {
    entry.title = lines[titleAt].slice(4).trim()
  }
  for (const [key, label] of FIELDS) {
    const prefix = `- **${label}:** `
    const line = lines.find((l) => l.startsWith(prefix))
    if (line) {
      const value = line.slice(prefix.length).trim()
      // The file is written as a link; the others as bare URLs.
      entry[key] = decodeURI(/^\[.*\]\((.*)\)$/.exec(value)?.[1] ?? value)
    }
  }
  const meta = lines.find((l) => l.startsWith("- **Branch:** "))
  const branch = meta && /^- \*\*Branch:\*\* `([^`]*)`/.exec(meta)?.[1]
  if (branch) {
    entry.branch = branch
  }
  const updated = /(?:updated|\*\*Updated:\*\*) (\d{4}-\d{2}-\d{2})/.exec(
    block,
  )?.[1]
  if (updated) {
    entry.updated = updated
  }
  const fieldsAt = lines.findIndex((l) => l.startsWith("- **"))
  const summary = lines
    .slice(titleAt + 1, fieldsAt === -1 ? undefined : fieldsAt)
    .join("\n")
    .trim()
  if (summary) {
    entry.summary = summary
  }
  return entry
}

/** The Markdown block for one entry, between its markers. */
export function renderEntry(entry: IndexEntry): string {
  const lines = [
    startMarker(entry.name),
    `### ${entry.title ?? entry.name}`,
    "",
  ]
  if (entry.summary) {
    lines.push(entry.summary, "")
  }
  for (const [key, label] of FIELDS) {
    const value = entry[key]
    if (value) {
      lines.push(
        `- **${label}:** ${key === "file" ? `[${path.posix.basename(value)}](${encodeURI(value)})` : value}`,
      )
    }
  }
  const meta = [
    entry.branch ? `\`${entry.branch}\`` : undefined,
    entry.updated ? `updated ${entry.updated}` : undefined,
  ].filter(Boolean)
  if (entry.branch) {
    lines.push(`- **Branch:** ${meta.join(", ")}`)
  } else if (entry.updated) {
    lines.push(`- **Updated:** ${entry.updated}`)
  }
  lines.push(endMarker(entry.name))
  return lines.join("\n")
}

/**
 * `text` (the index file's content, empty when it's new) with `entry` in it:
 * its block replaced in place when it's there, the fields it doesn't give
 * kept from before, else a new block above every other entry (newest first).
 */
export function upsertEntry(
  text: string,
  entry: IndexEntry,
): { text: string; entry: IndexEntry; added: boolean } {
  const start = startMarker(entry.name)
  const end = endMarker(entry.name)
  const at = text.indexOf(start)
  const endAt = at === -1 ? -1 : text.indexOf(end, at)
  if (at !== -1 && endAt !== -1) {
    const merged: IndexEntry = parseEntry(entry.name, text.slice(at, endAt))
    for (const [key, value] of Object.entries(entry)) {
      if (value) {
        ;(merged as Record<string, string>)[key] = value
      }
    }
    return {
      text:
        text.slice(0, at) +
        renderEntry(merged) +
        text.slice(endAt + end.length),
      entry: merged,
      added: false,
    }
  }
  const block = `${renderEntry(entry)}\n`
  if (!text.trim()) {
    return { text: `${INDEX_HEADER}\n${block}`, entry, added: true }
  }
  const first = text.indexOf("<!-- prototype: ")
  return {
    text:
      first === -1
        ? `${text.replace(/\n*$/, "\n")}\n${block}`
        : `${text.slice(0, first)}${block}\n${text.slice(first)}`,
    entry,
    added: true,
  }
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * `value` when it's a link that outlasts the session (http or https, and not
 * on this machine), else a UsageError naming `flag`.
 */
export function lastingUrl(
  flag: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UsageError(`--${flag} must be a URL: ${value}`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`--${flag} must be an http(s) URL: ${value}`)
  }
  if (
    /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(url.hostname)
  ) {
    throw new UsageError(
      `--${flag} is a link on this machine, which doesn't outlast the session: record the kept page with --file instead`,
    )
  }
  return value
}

/** Add or update a mockup's entry in `prototype.index`. */
function record(root: string, index: string | null, flags: Flags) {
  if (!index) {
    throw new UsageError(
      "prototype.index isn't set: there's no file to record mockups in",
    )
  }
  const name = requiredFlag(flags, "name")
  if (!NAME.test(name)) {
    throw new UsageError(`--name must be kebab-case: ${name}`)
  }
  const page = lastingUrl("page", flags.get("page"))
  const design = lastingUrl("design", flags.get("design"))
  let file: string | undefined
  const given = flags.get("file")
  if (given) {
    const absolute = path.resolve(root, given)
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      throw new UsageError(
        `--file must be a page inside the repo (one kept in prototype.dir): ${given}`,
      )
    }
    file = path
      .relative(path.dirname(index), absolute)
      .split(path.sep)
      .join("/")
  }
  let text = ""
  try {
    text = fs.readFileSync(index, "utf8")
  } catch {}
  if (!page && !design && !file && !text.includes(startMarker(name))) {
    throw new UsageError(
      "nothing lasting to record: give --page, --design, or --file",
    )
  }
  const branch = run("git", ["branch", "--show-current"], root).stdout.trim()
  const result = upsertEntry(text, {
    name,
    title: flags.get("title"),
    summary: flags.get("summary")?.trim(),
    page,
    design,
    file,
    branch: branch || undefined,
    updated: new Date().toISOString().slice(0, 10),
  })
  fs.mkdirSync(path.dirname(index), { recursive: true })
  fs.writeFileSync(index, result.text)
  return {
    status: result.added ? "added" : "updated",
    index,
    entry: result.entry,
  }
}

/** The static server prototype started in a worktree, as recorded. */
type ServerState = {
  pid: number
  dir: string
  url: string | null
  log: string
  startedAt: string
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
}

/**
 * The file a request path names inside `dir`, or undefined when it would
 * leave `dir` (`..`, an encoded slash) or can't be decoded. `/` is the index.
 */
export function resolveRequest(
  dir: string,
  urlPath: string,
): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath.split(/[?#]/)[0] ?? "/")
  } catch {
    return undefined
  }
  if (decoded.includes("\0")) {
    return undefined
  }
  const file = path.resolve(dir, `.${path.posix.normalize(`/${decoded}`)}`)
  return file === dir || file.startsWith(`${dir}${path.sep}`) ? file : undefined
}

/** The index page: a link to each mockup in `dir`, newest first. */
export function indexPage(dir: string, files: string[]): string {
  const html = (s: string) =>
    s.replace(
      /[&<>"]/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
    )
  const items = files
    .map((f) => `<li><a href="${encodeURI(f)}">${html(f)}</a></li>`)
    .join("\n")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mockups</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:2rem;max-width:40rem}</style>
</head><body><h1>Mockups</h1><p>${html(dir)}</p>
${files.length ? `<ul>\n${items}\n</ul>` : "<p>None yet.</p>"}
</body></html>
`
}

function htmlFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.html?$/i.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .map((x) => x.f)
  } catch {
    return []
  }
}

/**
 * Serve `dir` on localhost, printing the URL it serves on, until killed, or
 * (with `idleMinutes`) until `dir` is gone or nothing has asked for a page in
 * that long.
 */
export function serveStatic(
  dir: string,
  port = 0,
  idleMinutes = 0,
): http.Server {
  let last = Date.now()
  const server = http.createServer((req, res) => {
    last = Date.now()
    // Never cached, so a reload after an edit shows the edit.
    res.setHeader("Cache-Control", "no-store")
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end()
      return
    }
    const file = resolveRequest(dir, req.url ?? "/")
    if (!file) {
      res.writeHead(400).end()
      return
    }
    if (file === dir) {
      res.writeHead(200, { "Content-Type": TYPES[".html"] })
      res.end(
        req.method === "HEAD" ? undefined : indexPage(dir, htmlFiles(dir)),
      )
      return
    }
    fs.readFile(file, (error, body) => {
      if (error) {
        res.writeHead(404, { "Content-Type": TYPES[".txt"] })
        res.end("not found\n")
        return
      }
      const type =
        TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
      res.writeHead(200, { "Content-Type": type })
      res.end(req.method === "HEAD" ? undefined : body)
    })
  })
  server.listen(port, "127.0.0.1", () => {
    const address = server.address()
    const bound = typeof address === "object" && address ? address.port : port
    console.log(`Serving ${dir} at http://localhost:${bound}/`)
  })
  if (idleMinutes > 0) {
    const check = setInterval(() => {
      const idle = Date.now() - last > idleMinutes * 60_000
      if (idle || !fs.existsSync(dir)) {
        console.log(idle ? "Idle: stopping" : `${dir} is gone: stopping`)
        clearInterval(check)
        server.close()
        server.closeAllConnections()
      }
    }, 60_000)
    check.unref()
  }
  return server
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(2000),
    })
    return response.status < 500
  } catch {
    return false
  }
}

function stateFile(state: string): string {
  return path.join(state, "server.json")
}

function readState(state: string): ServerState | undefined {
  try {
    return JSON.parse(fs.readFileSync(stateFile(state), "utf8")) as ServerState
  } catch {
    return undefined
  }
}

function tail(file: string, lines = 30): string {
  try {
    return fs
      .readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .slice(-lines)
      .join("\n")
  } catch {
    return ""
  }
}

/** The URL a `static` server printed in its log, once it has. */
export function urlFromLog(text: string): string | undefined {
  return /^Serving .* at (http:\/\/localhost:\d+\/)$/m.exec(text)?.[1]
}

/** Stop the server prototype started in this worktree, if it still runs. */
async function stop(
  state: string,
): Promise<{ stopped: boolean; pid?: number; reason?: string }> {
  const running = readState(state)
  fs.rmSync(stateFile(state), { force: true })
  if (!running || !alive(running.pid)) {
    return { stopped: false, reason: "no server prototype started is running" }
  }
  process.kill(running.pid, "SIGTERM")
  for (let i = 0; i < 20 && alive(running.pid); i++) {
    await sleep(250)
  }
  if (alive(running.pid)) {
    process.kill(running.pid, "SIGKILL")
  }
  return { stopped: true, pid: running.pid }
}

/** Start `static` for `dir` in the background, and wait until it answers. */
async function start(state: string, dir: string) {
  const log = path.join(state, "server.log")
  const out = fs.openSync(log, "w")
  const child = spawn(
    process.execPath,
    [import.meta.filename, "static", dir, "--idle", String(IDLE_MINUTES)],
    { detached: true, stdio: ["ignore", out, out] },
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
  const record: ServerState = {
    pid,
    dir,
    url: null,
    log,
    startedAt: new Date().toISOString(),
  }
  const deadline = Date.now() + TIMEOUT * 1000
  while (Date.now() < deadline) {
    await sleep(200)
    if (exit !== undefined) {
      return { status: "failed", url: null, pid, log, tail: tail(log) }
    }
    const url = urlFromLog(tail(log, 20))
    if (url && (await answers(url))) {
      fs.writeFileSync(
        stateFile(state),
        `${JSON.stringify({ ...record, url }, null, 2)}\n`,
      )
      return { status: "started", url, pid, log }
    }
  }
  fs.writeFileSync(stateFile(state), `${JSON.stringify(record, null, 2)}\n`)
  return { status: "timeout", url: null, pid, log, tail: tail(log) }
}

const USAGE = `Usage: prototype.ts <subcommand>

  dir                  Print the folder for this worktree's mockup pages,
                       creating it: prototype.dir when the config sets one
                       (kept: true), else a scratch folder in its git dir,
                       and index: the prototype.index file, or null
  record --name <name> [--title <words>] [--summary <text>] [--page <url>]
         [--design <url>] [--file <path>]
                       Add the mockup's entry to prototype.index, or update
                       it in place (fields not given keep their value). Links
                       must outlast the session: a hosted page, a design
                       link, or a page kept in the repo
  serve                Serve that folder on localhost, starting the server in
                       the background when this worktree has none running.
                       Prints its url, dir, and status. Pages are never cached
  stop                 Stop the server prototype started in this worktree
  static <dir> [--port <port>] [--idle <minutes>]
                       Serve <dir> in the foreground (what serve runs),
                       stopping once <dir> is gone or after <minutes> with
                       no request`

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  try {
    if (command === "static") {
      const [dir, ...flagArgs] = rest
      if (!dir) {
        throw new UsageError("static needs the folder to serve")
      }
      const flags = parseFlags(flagArgs)
      serveStatic(
        fs.realpathSync(dir),
        Number(flags.get("port") ?? 0),
        Number(flags.get("idle") ?? 0),
      )
      return
    }
    if (
      command !== "dir" &&
      command !== "serve" &&
      command !== "stop" &&
      command !== "record"
    ) {
      console.log(USAGE)
      process.exitCode = command && command !== "help" ? 1 : 0
      return
    }
    const flags = parseFlags(rest)
    const root = fs.realpathSync(repoRoot())
    const state = stateDir("prototype", { cwd: root })
    if (command === "stop") {
      printJson(await stop(state))
      return
    }
    const config = loadConfig(root).config ?? {}
    const index = indexFile(root, getAt(config, "prototype.index"))
    if (command === "record") {
      printJson(record(root, index, flags))
      return
    }
    const { dir, kept } = pagesDir(root, state, getAt(config, "prototype.dir"))
    fs.mkdirSync(dir, { recursive: true })
    if (command === "dir") {
      printJson({ dir, kept, index })
      return
    }
    const running = readState(state)
    if (
      running &&
      running.dir === dir &&
      running.url &&
      alive(running.pid) &&
      (await answers(running.url))
    ) {
      printJson({
        status: "running",
        url: running.url,
        dir,
        kept,
        pid: running.pid,
        log: running.log,
      })
      return
    }
    // It stopped answering, or there's none: start afresh.
    await stop(state)
    const result = await start(state, dir)
    printJson({ ...result, dir, kept })
    if (result.status !== "started") {
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

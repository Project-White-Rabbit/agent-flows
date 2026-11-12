// The mechanical half of prototype, for a session that shows its mockups in a
// browser: a scratch folder in the worktree's own git dir for the pages (never
// the working tree, so a mockup can't end up committed), served over HTTP so a
// browser (and the agent's browser tools, which often refuse file:// pages)
// can open a mockup and reload it after each edit. What the mockup shows, and
// where the person sees it, stays in the skill.
//
// The server is this file run as `static`, started in the background through
// preview's machinery and recorded beside the pages, so each worktree has its
// own and `stop` stops only that one.

import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { repoRoot } from "./configure.ts"
import {
  isMain,
  parseFlags,
  printJson,
  stateDir,
  USAGE_EXIT,
  UsageError,
} from "./lib.ts"
import { alive, answers, readState, start, stop } from "./preview.ts"

/** Seconds to wait for the static server to answer: it starts at once. */
const TIMEOUT = 15

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

/** Serve `dir` on localhost until killed, printing the URL it serves on. */
export function serveStatic(dir: string, port = 0): http.Server {
  const server = http.createServer((req, res) => {
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
  return server
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const USAGE = `Usage: prototype.ts <subcommand>

  dir                  Print the scratch folder for this worktree's mockup
                       pages (in its git dir, never the working tree),
                       creating it
  serve                Serve that folder on localhost, starting the server in
                       the background when this worktree has none running.
                       Prints its url, dir, and status. Pages are never cached
  stop                 Stop the server prototype started in this worktree
  static <dir> [--port <port>]
                       Serve <dir> in the foreground (what serve runs)`

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  try {
    if (command === "static") {
      const [dir, ...flagArgs] = rest
      if (!dir) {
        throw new UsageError("static needs the folder to serve")
      }
      const port = Number(parseFlags(flagArgs).get("port") ?? 0)
      serveStatic(fs.realpathSync(dir), port)
      return
    }
    if (command !== "dir" && command !== "serve" && command !== "stop") {
      console.log(USAGE)
      process.exitCode = command && command !== "help" ? 1 : 0
      return
    }
    parseFlags(rest)
    const root = fs.realpathSync(repoRoot())
    const state = stateDir("prototype", { cwd: root })
    if (command === "stop") {
      printJson(await stop(state, "prototype"))
      return
    }
    const dir = path.join(state, "pages")
    fs.mkdirSync(dir, { recursive: true })
    if (command === "dir") {
      printJson({ dir })
      return
    }
    const serveCommand = [
      shellQuote(process.execPath),
      shellQuote(import.meta.filename),
      "static",
      shellQuote(dir),
    ].join(" ")
    const running = readState(state)
    if (running && alive(running.pid)) {
      if (
        running.command === serveCommand &&
        running.url &&
        (await answers(running.url))
      ) {
        printJson({
          status: "running",
          url: running.url,
          dir,
          pid: running.pid,
          log: running.log,
        })
        return
      }
      // It stopped answering, or a moved plugin runs another copy: start afresh.
      await stop(state, "prototype")
    }
    const result = await start(root, state, {
      command: serveCommand,
      url: null,
      timeout: TIMEOUT,
    })
    printJson({
      status: result.status,
      url: result.url,
      dir,
      pid: result.pid,
      log: result.log,
      ...(result.tail ? { tail: result.tail } : {}),
    })
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

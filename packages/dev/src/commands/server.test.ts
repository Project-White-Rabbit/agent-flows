import { describe, expect, it } from "vitest"
import {
  adoptPlan,
  type Deps,
  findServer,
  isShell,
  type Listener,
  parseCwds,
  parseEtime,
  parseLsof,
  running,
  type ServerState,
  type Settings,
  sweep,
  urlFromLog,
  watchVerdict,
} from "./server.ts"

describe("urlFromLog", () => {
  it("reads the local URL a dev server prints, past its colors", () => {
    expect(
      urlFromLog(
        "  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  ➜  Network: http://192.168.1.4:5173/",
      ),
    ).toBe("http://localhost:5173/")
  })

  it("prefers a local address over a network one, and reads 0.0.0.0 as localhost", () => {
    expect(
      urlFromLog("Network: http://10.0.0.2:3000\nLocal: http://localhost:3000"),
    ).toBe("http://localhost:3000")
    expect(urlFromLog("Listening on http://0.0.0.0:8000.")).toBe(
      "http://localhost:8000",
    )
  })

  it("finds nothing in output without a URL", () => {
    expect(urlFromLog("compiling...\nready in 300ms")).toBeUndefined()
  })
})

describe("lsof parsing", () => {
  it("reads each process's listening ports once", () => {
    expect(
      parseLsof(
        "p101\nf20\nn*:3000\nf21\nn[::1]:3000\np202\nf5\nn127.0.0.1:5432\n",
      ),
    ).toEqual([
      { pid: 101, port: 3000 },
      { pid: 202, port: 5432 },
    ])
  })

  it("reads each process's working directory", () => {
    expect(parseCwds("p101\nfcwd\nn/repo/web\np202\nfcwd\nn/other\n")).toEqual(
      new Map([
        [101, "/repo/web"],
        [202, "/other"],
      ]),
    )
  })
})

describe("findServer", () => {
  const settings = (over: Partial<Settings> = {}): Settings => ({
    command: "bun run dev",
    url: null,
    timeout: 120,
    idleTimeout: 240,
    ...over,
  })
  const deps = (
    listeners: Listener[],
    over: Partial<Deps> & { up?: string[] } = {},
  ): Deps => ({
    root: "/repo",
    state: undefined,
    listeners: () => listeners,
    answers: async (url) => (over.up ?? []).includes(url),
    running: () => false,
    ...over,
  })
  const web = { pid: 1, port: 3000, cwd: "/repo/apps/web", command: "next dev" }
  const api = { pid: 2, port: 4000, cwd: "/repo", command: "node api.js" }
  const other = { pid: 3, port: 3000, cwd: "/repo-2", command: "next dev" }

  it("finds this checkout's one server", async () => {
    expect(await findServer(settings(), deps([web, other]))).toMatchObject({
      status: "running",
      url: "http://localhost:3000",
      servers: [web],
      ours: false,
    })
  })

  it("keeps the configured URL's path on the port this checkout serves", async () => {
    const found = await findServer(
      settings({ url: "http://localhost:3000/app" }),
      deps([{ ...web, port: 3001 }]),
    )
    expect(found?.url).toBe("http://localhost:3001/app")
  })

  it("picks the configured port among several, and none without it", async () => {
    expect(
      (
        await findServer(
          settings({ url: "http://localhost:4000" }),
          deps([web, api]),
        )
      )?.url,
    ).toBe("http://localhost:4000/")
    expect(await findServer(settings(), deps([web, api]))).toMatchObject({
      status: "running",
      url: null,
      servers: [web, api],
    })
  })

  it("says when another checkout's server holds the configured URL", async () => {
    expect(
      await findServer(
        settings({ url: "http://localhost:3000" }),
        deps([other], { up: ["http://localhost:3000"] }),
      ),
    ).toMatchObject({ status: "elsewhere", owner: other })
  })

  it("takes an answering URL as this checkout's when whose it is can't be told", async () => {
    expect(
      await findServer(
        settings({ url: "http://localhost:3000" }),
        deps([], { up: ["http://localhost:3000"] }),
      ),
    ).toMatchObject({ status: "running", url: "http://localhost:3000" })
  })

  it("finds the server it started where it said it serves", async () => {
    const state = {
      pid: 9,
      command: "bun run dev",
      url: "http://localhost:5173/",
      log: "/git/agent-flows/preview/server.log",
      startedAt: "2026-11-09T00:00:00Z",
    }
    expect(
      await findServer(
        settings(),
        deps([], { state, running: () => true, up: [state.url] }),
      ),
    ).toMatchObject({ status: "running", url: state.url, ours: true, pid: 9 })
  })

  it("finds nothing when nothing runs", async () => {
    expect(
      await findServer(settings({ url: "http://localhost:3000" }), deps([])),
    ).toBeUndefined()
  })
})

describe("the servers preview started", () => {
  const server = (pid: number): ServerState => ({
    pid,
    command: "bun run dev",
    url: "http://localhost:3000/",
    log: `/git/agent-flows/preview/logs/${pid}.log`,
    startedAt: "2026-11-09T00:00:00Z",
  })
  const started = Date.parse("2026-11-09T00:00:00Z")

  it("reads ps elapsed times", () => {
    expect(parseEtime("  05:07\n")).toBe(307)
    expect(parseEtime("02:05:07")).toBe(7507)
    expect(parseEtime("3-02:05:07")).toBe(3 * 86400 + 7507)
    expect(parseEtime("")).toBeUndefined()
  })

  it("counts one as running only while the process that started then lives", () => {
    const probe = (alive: boolean, seconds: number | undefined) => ({
      groupAlive: () => alive,
      elapsed: () => seconds,
      now: started + 3600_000,
    })
    expect(running(server(1), probe(true, 3600))).toBe(true)
    expect(running(server(1), probe(false, 3600))).toBe(false)
    // Its pid now belongs to a process that started an hour later.
    expect(running(server(1), probe(true, 5))).toBe(false)
    // The shell is gone and only its process group runs.
    expect(running(server(1), probe(true, undefined))).toBe(true)
  })

  it("stops the ones whose worktree is gone and drops the ones that ended", () => {
    const registry = {
      "/repo": server(1),
      "/repo-gone": server(2),
      "/repo-ended": server(3),
    }
    expect(
      sweep(registry, new Set(["/repo", "/repo-ended"]), (s) => s.pid !== 3),
    ).toEqual({
      kept: { "/repo": server(1) },
      orphans: [["/repo-gone", server(2)]],
    })
  })

  it("stops none when the worktrees couldn't be listed", () => {
    expect(sweep({ "/repo-gone": server(2) }, undefined, () => true)).toEqual({
      kept: { "/repo-gone": server(2) },
      orphans: [],
    })
  })
})

describe("the watchdog", () => {
  const look = (over: Partial<Parameters<typeof watchVerdict>[0]> = {}) =>
    watchVerdict({
      rootExists: true,
      connected: false,
      lastActive: 0,
      now: 60 * 60_000,
      idleMs: 60 * 60_000,
      ...over,
    })

  it("stops the server once its worktree is gone, whatever else", () => {
    expect(look({ rootExists: false, connected: true, idleMs: 0 })).toBe("gone")
  })

  it("stops it once nothing has been connected for the idle timeout", () => {
    expect(look()).toBe("idle")
    expect(look({ now: 59 * 60_000 })).toBeUndefined()
  })

  it("keeps it while something is connected, it can't tell, or there's no timeout", () => {
    expect(look({ connected: true })).toBeUndefined()
    expect(look({ connected: undefined })).toBeUndefined()
    expect(look({ idleMs: 0 })).toBeUndefined()
  })
})

describe("adopting a server preview didn't start", () => {
  it("tells a shell from what it runs", () => {
    expect(isShell("-zsh")).toBe(true)
    expect(isShell("/bin/bash --login")).toBe(true)
    expect(isShell("sh -c bun run dev")).toBe(true)
    expect(isShell("node next dev")).toBe(false)
  })

  // A terminal running `bun run dev` (a package manager, a script shell, a
  // node), and an agent whose tool shell ran a server in the background.
  const procs = [
    { pid: 10, ppid: 1, command: "-zsh" },
    { pid: 11, ppid: 10, command: "bun run dev" },
    { pid: 12, ppid: 11, command: "/bin/sh -c next dev" },
    { pid: 13, ppid: 12, command: "node node_modules/.bin/next dev" },
    { pid: 14, ppid: 13, command: "node next-render-worker" },
    { pid: 30, ppid: 1, command: "claude" },
    { pid: 31, ppid: 30, command: "/bin/bash -c python3 -m http.server" },
    { pid: 32, ppid: 31, command: "python3 -m http.server" },
    { pid: 33, ppid: 30, command: "node preview.ts adopt" },
  ]

  it("stops the tree up to the nearest shell, never the shell", () => {
    expect(adoptPlan(13, procs, 33)).toEqual({ pids: [13, 14] })
    expect(adoptPlan(32, procs, 33)).toEqual({ pids: [32] })
  })

  it("never stops what preview runs under", () => {
    const tree = [
      { pid: 30, ppid: 1, command: "claude" },
      { pid: 32, ppid: 30, command: "python3 -m http.server" },
      { pid: 33, ppid: 30, command: "node preview.ts adopt" },
    ]
    expect(adoptPlan(32, tree, 33)).toEqual({ pids: [32] })
    expect(adoptPlan(30, tree, 33)).toMatchObject({
      refuse: expect.any(String),
    })
  })

  it("refuses a shell, or a process that's gone", () => {
    expect(adoptPlan(10, procs, 33)).toMatchObject({
      refuse: expect.any(String),
    })
    expect(adoptPlan(99, procs, 33)).toEqual({
      refuse: "no process 99 is running",
    })
  })
})

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CONFIG_VERSION } from "../config/config.ts"
import {
  adoptPlan,
  type Deps,
  findManaged,
  findServer,
  isShell,
  type Listener,
  type ManagedRun,
  type Manager,
  managedRun,
  managerCommand,
  parseCwds,
  parseEtime,
  parseLsof,
  parsePorts,
  pickPort,
  running,
  runShell,
  type ServerState,
  type Settings,
  serverHooks,
  serverTarget,
  startManaged,
  stopManaged,
  sweep,
  urlFromLog,
  watchVerdict,
  withPort,
} from "./server.ts"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("a port of its own", () => {
  it("reads a range, or one port, and refuses anything else", () => {
    expect(parsePorts("3001-3099")).toEqual([3001, 3099])
    expect(parsePorts("4000")).toEqual([4000, 4000])
    expect(parsePorts("3099-3001")).toBeUndefined()
    expect(parsePorts("0-10")).toBeUndefined()
    expect(parsePorts("70000")).toBeUndefined()
    expect(parsePorts("3001,3002")).toBeUndefined()
  })

  it("keeps a worktree's port while it's free, else takes the first nobody listens on or holds", () => {
    const none = new Set<number>()
    expect(pickPort([3001, 3005], 3003, none, none)).toBe(3003)
    expect(pickPort([3001, 3005], 3003, new Set([3003]), none)).toBe(3001)
    expect(pickPort([3001, 3005], 4000, none, none)).toBe(3001)
    expect(
      pickPort([3001, 3005], undefined, new Set([3001]), new Set([3002])),
    ).toBe(3003)
  })

  it("takes a port another worktree holds before giving up, but never one in use", () => {
    expect(
      pickPort([3001, 3002], undefined, new Set([3001]), new Set([3002])),
    ).toBe(3002)
    expect(
      pickPort([3001, 3002], undefined, new Set([3001, 3002]), new Set()),
    ).toBeUndefined()
  })

  it("puts the port in the command and the URL", () => {
    const settings: Settings & { command: string } = {
      command: "bun run dev --port {port}",
      url: null,
      ports: [3001, 3099],
      timeout: 120,
      idleTimeout: 240,
    }
    expect(withPort(settings, 3004)).toMatchObject({
      command: "bun run dev --port 3004",
      url: "http://localhost:3004",
      port: 3004,
    })
    expect(
      withPort({ ...settings, url: "http://127.0.0.1:3000/app" }, 3004).url,
    ).toBe("http://127.0.0.1:3004/app")
  })
})

describe("the server's hooks", () => {
  function repo(config: unknown): string {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "server-hooks-")),
    )
    dirs.push(root)
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
    git("init", "--quiet", "--initial-branch", "main")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    git("commit", "--quiet", "--allow-empty", "-m", "base")
    fs.mkdirSync(path.join(root, ".agent-flows"))
    fs.writeFileSync(
      path.join(root, ".agent-flows", "config.json"),
      JSON.stringify(config),
    )
    return root
  }

  it("runs the started hooks with where the server serves, and the stopped ones after", () => {
    const root = repo({
      version: CONFIG_VERSION,
      repo: { baseBranch: "main" },
      server: {
        command: "bun run dev",
        started: [
          { name: "url", run: "echo {url} {port} > url.txt" },
          { name: "broken", run: "exit 1" },
        ],
        stopped: [{ name: "url", run: "rm url.txt" }],
      },
    })
    const started = serverHooks(root, "server.started", {
      url: "http://localhost:3004",
      port: 3004,
    })
    expect(fs.readFileSync(path.join(root, "url.txt"), "utf8")).toBe(
      "http://localhost:3004 3004\n",
    )
    expect(started?.failures.map((f) => f.name)).toEqual(["broken"])
    const stopped = serverHooks(root, "server.stopped", {
      url: "http://localhost:3004",
    })
    expect(stopped?.ran.map((r) => r.result)).toEqual(["passed"])
    expect(fs.existsSync(path.join(root, "url.txt"))).toBe(false)
  })

  it("does nothing when the point has no hooks", () => {
    const root = repo({ version: CONFIG_VERSION, repo: { baseBranch: "main" } })
    expect(
      serverHooks(root, "server.started", { url: "http://localhost:3000" }),
    ).toBeUndefined()
  })
})

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
    ports: null,
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

describe("a server the repo's own manager runs", () => {
  function managed(
    manager: Partial<Manager> & { up: string },
    overrides: Partial<Settings> = {},
    live: (url: string) => boolean = () => true,
  ): ManagedRun {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "server-managed-")),
    )
    dirs.push(root)
    spawnSync("git", ["-C", root, "init", "--quiet"])
    return {
      root,
      log: path.join(root, "up.log"),
      manager: {
        down: null,
        restart: null,
        status: null,
        list: null,
        ...manager,
      },
      vars: { branch: "feat/x", worktree: root },
      settings: {
        command: null,
        url: null,
        ports: null,
        timeout: 5,
        idleTimeout: 240,
        ...overrides,
      },
      answers: async (url) => live(url),
    }
  }

  it("fills the branch and worktree in, quoted, and the port when there is one", () => {
    expect(
      managerCommand("dsm up {branch} --dir {worktree} --port {port}", {
        branch: "it's",
        worktree: "/w",
        port: 3004,
      }),
    ).toBe("dsm up 'it'\\''s' --dir '/w' --port 3004")
    expect(managerCommand("up {port}", { branch: "b", worktree: "/w" })).toBe(
      "up {port}",
    )
  })

  it("waits for the command, not for a daemon it leaves holding its output", async () => {
    const m = managed({ up: "true" })
    const started = Date.now()
    const ran = await runShell(m.root, "(sleep 5 &) ; echo up", {}, 10)
    expect(ran).toMatchObject({ exitCode: 0, timedOut: false })
    expect(ran.output.trim()).toBe("up")
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it("finds the one running through status, without running up", async () => {
    const m = managed({
      up: "touch up-ran",
      status: "echo bitfab http://localhost:3012",
    })
    expect(await findManaged(m)).toMatchObject({
      status: "running",
      url: "http://localhost:3012",
      managed: true,
      watched: false,
    })
    expect(fs.existsSync(path.join(m.root, "up-ran"))).toBe(false)
  })

  it("counts it stopped when status fails or its URL doesn't answer", async () => {
    expect(
      await findManaged(managed({ up: "true", status: "exit 1" })),
    ).toBeUndefined()
    expect(
      await findManaged(
        managed(
          { up: "true", status: "echo http://localhost:3012" },
          {},
          () => false,
        ),
      ),
    ).toBeUndefined()
    expect(await findManaged(managed({ up: "true" }))).toBeUndefined()
  })

  it("starts it with up and reads the URL up printed, with what it's given", async () => {
    const up =
      'echo "$BRANCH" > branch.txt; echo "  ● bitfab → http://localhost:3012"'
    const m = managed({ up })
    expect(await startManaged(m)).toMatchObject({
      status: "started",
      url: "http://localhost:3012",
      managed: true,
      command: up,
      log: m.log,
    })
    expect(fs.readFileSync(path.join(m.root, "branch.txt"), "utf8")).toBe(
      "feat/x\n",
    )
  })

  it("takes the URL from status over what up printed, else the config's", async () => {
    const fromStatus = managed({
      up: "echo http://localhost:1111",
      status: "echo http://localhost:2222",
    })
    expect((await startManaged(fromStatus)).url).toBe("http://localhost:2222")
    const fromPort = managed({ up: "true" }, { ports: [3001, 3099] })
    fromPort.vars.port = 3007
    expect((await startManaged(fromPort)).url).toBe("http://localhost:3007")
  })

  it("fails when up fails, or when its URL can't be known", async () => {
    expect(
      await startManaged(managed({ up: "echo overmind not found; exit 3" })),
    ).toMatchObject({
      status: "failed",
      exitCode: 3,
      tail: "overmind not found",
    })
    const unknown = await startManaged(managed({ up: "true" }))
    expect(unknown.status).toBe("failed")
    expect(unknown.reason).toMatch(/URL isn't known/)
  })

  it("times out when the URL never answers", async () => {
    expect(
      await startManaged(
        managed(
          { up: "echo http://localhost:3012" },
          { timeout: 1 },
          () => false,
        ),
      ),
    ).toMatchObject({ status: "timeout", url: "http://localhost:3012" })
  })

  it("restarts it with restart, else down and then up", async () => {
    const own = managed({
      up: "touch up-ran; echo http://localhost:3012",
      restart: "touch restart-ran; echo http://localhost:3012",
    })
    expect((await startManaged(own, true)).status).toBe("started")
    expect(fs.existsSync(path.join(own.root, "restart-ran"))).toBe(true)
    expect(fs.existsSync(path.join(own.root, "up-ran"))).toBe(false)

    const pair = managed({
      up: "test -f down-ran && echo http://localhost:3012",
      down: "touch down-ran",
    })
    expect(await startManaged(pair, true)).toMatchObject({
      status: "started",
      url: "http://localhost:3012",
    })
  })

  it("stops it with down, and says why when it can't", async () => {
    const m = managed({ up: "true", down: "touch down-ran; echo stopped" })
    expect(await stopManaged(m, false)).toMatchObject({
      stopped: [{ worktree: m.root, command: "touch down-ran; echo stopped" }],
      output: "stopped",
    })
    expect(fs.existsSync(path.join(m.root, "down-ran"))).toBe(true)
    expect((await stopManaged(m, true)).reason).toMatch(/manager's to do/)
    expect((await stopManaged(managed({ up: "true" }), false)).reason).toMatch(
      /server.down isn't set/,
    )
    expect(
      await stopManaged(managed({ up: "true", down: "exit 4" }), false),
    ).toMatchObject({ stopped: [], reason: "server.down exited 4" })
  })
})

describe("a server for another branch", () => {
  function repoWithWorktree(): { main: string; other: string } {
    const main = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "server-branch-")),
    )
    dirs.push(main)
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", main, ...args], { encoding: "utf8" })
    git("init", "--quiet", "--initial-branch", "main")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    git("commit", "--quiet", "--allow-empty", "-m", "base")
    const other = `${main}-feat`
    dirs.push(other)
    git("worktree", "add", "--quiet", "-b", "feat/x", other)
    return { main, other: fs.realpathSync(other) }
  }

  it("runs from the worktree that has the branch checked out", () => {
    const { main, other } = repoWithWorktree()
    expect(serverTarget(main, undefined)).toEqual({ root: main })
    expect(serverTarget(main, "feat/x")).toEqual({ root: other })
    expect(serverTarget(other, "main")).toEqual({ root: main })
    expect(serverTarget(main, "nowhere")).toEqual({
      root: main,
      elsewhere: "nowhere",
    })
  })

  it("hands a manager a branch no worktree holds, with no worktree", () => {
    const { main } = repoWithWorktree()
    const settings: Settings = {
      command: null,
      url: null,
      ports: null,
      timeout: 5,
      idleTimeout: 240,
    }
    const manager: Manager = {
      up: "dsm up {branch}",
      down: null,
      restart: null,
      status: null,
      list: null,
    }
    const dir = path.join(main, ".git", "server")
    expect(managedRun(dir, main, settings, manager, 3001).vars).toEqual({
      branch: "main",
      worktree: main,
      port: 3001,
    })
    const run = managedRun(dir, main, settings, manager, undefined, "feat/y")
    expect(run.vars).toEqual({ branch: "feat/y", worktree: "" })
    expect(run.log).toContain("branch-feat-y")
  })
})

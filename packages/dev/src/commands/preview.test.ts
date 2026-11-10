import { describe, expect, it } from "vitest"
import {
  type Deps,
  findServer,
  type Listener,
  parseCwds,
  parseLsof,
  type Settings,
  urlFromLog,
} from "./preview.ts"

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
    alive: () => false,
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
        deps([], { state, alive: () => true, up: [state.url] }),
      ),
    ).toMatchObject({ status: "running", url: state.url, ours: true, pid: 9 })
  })

  it("finds nothing when nothing runs", async () => {
    expect(
      await findServer(settings({ url: "http://localhost:3000" }), deps([])),
    ).toBeUndefined()
  })
})

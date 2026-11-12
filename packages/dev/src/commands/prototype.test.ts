import fs from "node:fs"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  indexPage,
  resolveRequest,
  serveStatic,
  urlFromLog,
} from "./prototype.ts"

describe("resolveRequest", () => {
  const dir = "/scratch/pages"

  it("maps a request path to a file in the folder, and / to the folder", () => {
    expect(resolveRequest(dir, "/settings-page.html")).toBe(
      "/scratch/pages/settings-page.html",
    )
    expect(resolveRequest(dir, "/settings-page.html?v=2")).toBe(
      "/scratch/pages/settings-page.html",
    )
    expect(resolveRequest(dir, "/a%20b.html")).toBe("/scratch/pages/a b.html")
    expect(resolveRequest(dir, "/")).toBe(dir)
  })

  it("never leaves the folder", () => {
    expect(resolveRequest(dir, "/../package.json")).toBe(
      "/scratch/pages/package.json",
    )
    expect(resolveRequest(dir, "/..%2f..%2fetc/passwd")).toBe(
      "/scratch/pages/etc/passwd",
    )
    expect(resolveRequest(dir, "/%E0%A4%A")).toBeUndefined()
    expect(resolveRequest(dir, "/a%00.html")).toBeUndefined()
  })
})

describe("indexPage", () => {
  it("links each prototype, escaped", () => {
    const page = indexPage("/scratch/pages", ["a&b.html", "plain.html"])
    expect(page).toContain('<a href="a&b.html">a&amp;b.html</a>')
    expect(page).toContain('<a href="plain.html">plain.html</a>')
    expect(indexPage("/scratch/pages", [])).toContain("None yet.")
  })
})

describe("serveStatic", () => {
  let dir: string
  let server: ReturnType<typeof serveStatic>
  let base: string

  beforeAll(async () => {
    dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "prototype-test-")),
    )
    fs.writeFileSync(path.join(dir, "demo.html"), "<h1>demo</h1>")
    server = serveStatic(dir)
    await new Promise((resolve) => server.once("listening", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("serves a prototype uncached, so a reload shows the latest edit", async () => {
    const res = await fetch(`${base}/demo.html`)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toBe("<h1>demo</h1>")
  })

  it("lists the prototypes at / and answers 404 for a missing file", async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain("demo.html")
    expect((await fetch(`${base}/missing.html`)).status).toBe(404)
    expect((await fetch(`${base}/demo.html`, { method: "POST" })).status).toBe(
      405,
    )
  })
})

describe("urlFromLog", () => {
  it("reads the URL the static server printed", () => {
    expect(
      urlFromLog("Serving /scratch/pages at http://localhost:51234/\n"),
    ).toBe("http://localhost:51234/")
  })

  it("is undefined before the server has printed it", () => {
    expect(urlFromLog("")).toBeUndefined()
    expect(urlFromLog("Error: listen EADDRINUSE")).toBeUndefined()
  })
})

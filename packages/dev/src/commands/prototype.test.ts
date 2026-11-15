import fs from "node:fs"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  indexFile,
  indexPage,
  lastingUrl,
  pagesDir,
  parseEntry,
  renderEntry,
  resolveRequest,
  serveStatic,
  upsertEntry,
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

describe("pagesDir", () => {
  it("is the scratch folder by default", () => {
    for (const dir of [undefined, null, false, ""]) {
      expect(
        pagesDir("/repo", "/repo/.git/agent-flows/prototype", dir),
      ).toEqual({ dir: "/repo/.git/agent-flows/prototype/pages", kept: false })
    }
  })

  it("is prototype.dir inside the checkout when set", () => {
    expect(pagesDir("/repo", "/state", "prototypes")).toEqual({
      dir: "/repo/prototypes",
      kept: true,
    })
  })

  it("refuses a folder outside the checkout", () => {
    expect(() => pagesDir("/repo", "/state", "../elsewhere")).toThrow(
      "inside the repo",
    )
    expect(() => pagesDir("/repo", "/state", ".")).toThrow("inside the repo")
  })
})

describe("indexFile", () => {
  it("is null when prototype.index isn't set", () => {
    for (const index of [undefined, null, false, ""]) {
      expect(indexFile("/repo", index)).toBeNull()
    }
  })

  it("is prototype.index inside the checkout", () => {
    expect(indexFile("/repo", "docs/prototypes.md")).toBe(
      "/repo/docs/prototypes.md",
    )
    expect(() => indexFile("/repo", "../prototypes.md")).toThrow(
      "inside the repo",
    )
  })
})

describe("the prototype index", () => {
  const settings = {
    name: "settings-page",
    title: "Settings page",
    summary: "Billing tabs on the settings screen.",
    page: "https://claude.ai/artifact/abc",
    branch: "ruven/settings",
    updated: "2026-11-15",
  }

  it("starts a new file with a header and the entry", () => {
    const { text, added } = upsertEntry("", settings)
    expect(added).toBe(true)
    expect(text).toMatch(/^# Prototypes\n/)
    expect(text).toContain("<!-- prototype: settings-page -->")
    expect(text).toContain("### Settings page")
    expect(text).toContain("- **Page:** https://claude.ai/artifact/abc")
    expect(text).toContain("- **Branch:** `ruven/settings`, updated 2026-11-15")
    expect(text.endsWith("<!-- /prototype: settings-page -->\n")).toBe(true)
  })

  it("reads back what it writes", () => {
    const entry = { ...settings, file: "../prototypes/settings page.html" }
    expect(parseEntry(entry.name, renderEntry(entry))).toEqual(entry)
    const bare = { name: "x", updated: "2026-11-15" }
    expect(parseEntry("x", renderEntry(bare))).toEqual({ ...bare, title: "x" })
  })

  it("updates an entry in place, keeping the fields not given", () => {
    const first = upsertEntry("", settings).text
    const withOther = upsertEntry(first, {
      name: "usage-chart",
      title: "Usage chart",
      design: "https://figma.com/design/k",
    }).text
    const { text, added, entry } = upsertEntry(withOther, {
      name: "settings-page",
      design: "https://figma.com/design/q",
      updated: "2026-11-16",
    })
    expect(added).toBe(false)
    expect(entry).toMatchObject({
      page: "https://claude.ai/artifact/abc",
      design: "https://figma.com/design/q",
      summary: "Billing tabs on the settings screen.",
      updated: "2026-11-16",
    })
    expect(text.match(/<!-- prototype: settings-page -->/g)).toHaveLength(1)
    // Newest first: the later entry sits above the earlier one.
    expect(text.indexOf("usage-chart")).toBeLessThan(
      text.indexOf("settings-page"),
    )
  })

  it("leaves the file's own text alone", () => {
    const own = "# Our mockups\n\nAsk design before shipping one.\n"
    const { text } = upsertEntry(own, settings)
    expect(text.startsWith(own)).toBe(true)
    expect(text).not.toContain("# Prototypes")
  })
})

describe("lastingUrl", () => {
  it("takes a hosted link", () => {
    expect(lastingUrl("page", "https://claude.ai/artifact/abc")).toBe(
      "https://claude.ai/artifact/abc",
    )
    expect(lastingUrl("page", undefined)).toBeUndefined()
  })

  it("refuses a link that doesn't outlast the session", () => {
    for (const url of [
      "http://localhost:5173/a.html",
      "http://127.0.0.1:8080/",
      "file:///tmp/a.html",
      "not a url",
    ]) {
      expect(() => lastingUrl("page", url)).toThrow()
    }
  })
})

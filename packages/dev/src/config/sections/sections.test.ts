import { describe, expect, it } from "vitest"
import { checkConfig, exampleConfig } from "../config.ts"
import type { FieldSpec } from "../types.ts"
import { parseGithubRemote } from "./github.ts"
import { parseGraphiteConfig } from "./graphite.ts"
import { SECTIONS } from "./index.ts"
import { inferLinearTeamKey } from "./linear.ts"
import { parseSentryConfig } from "./sentry.ts"

// The contract every section must meet. A new section that breaks the shared
// rules fails here, not in some flow later.
describe("section registry", () => {
  it("has unique, well-formed paths", () => {
    const paths = SECTIONS.map((s) => s.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const path of paths) {
      expect(path).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/)
      expect(["version", "skipped"]).not.toContain(path.split(".")[0])
    }
  })

  it("never nests a section inside another section", () => {
    for (const { path } of SECTIONS) {
      expect(SECTIONS.some((s) => path.startsWith(`${s.path}.`))).toBe(false)
    }
  })

  it.each(SECTIONS.map((s) => [s.path, s] as const))(
    "%s has unique fields whose examples match their types",
    (_path, spec) => {
      const keys = spec.fields.map((f) => f.key)
      expect(new Set(keys).size).toBe(keys.length)
      expect(spec.fields.some((f) => f.required)).toBe(true)
      for (const field of spec.fields) {
        expect(field.key).toMatch(/^[a-z][a-zA-Z0-9]*$/)
        expect(typeOf(field.example)).toBe(field.type ?? "string")
      }
    },
  )

  it("accepts a config built from every section's examples", () => {
    expect(checkConfig(exampleConfig())).toEqual({ issues: [], warnings: [] })
  })
})

function typeOf(value: FieldSpec["example"]): string {
  return Array.isArray(value) ? "string[]" : typeof value
}

describe("parseGithubRemote", () => {
  it.each([
    "git@github.com:acme/web.git",
    "https://github.com/acme/web",
    "https://github.com/acme/web.git",
    "ssh://git@github.com/acme/web.git",
  ])("parses %s", (url) => {
    expect(parseGithubRemote(url)).toEqual({ owner: "acme", repo: "web" })
  })

  it("ignores other hosts", () => {
    expect(parseGithubRemote("git@gitlab.com:acme/web.git")).toBeUndefined()
  })
})

describe("parseGraphiteConfig", () => {
  it("reads trunk or the first of trunks", () => {
    expect(parseGraphiteConfig('{"trunk":"main"}')).toBe("main")
    expect(parseGraphiteConfig('{"trunks":[{"name":"dev"}]}')).toBe("dev")
    expect(parseGraphiteConfig("not json")).toBeUndefined()
  })
})

describe("inferLinearTeamKey", () => {
  it("picks the most common ticket prefix, case-insensitively", () => {
    expect(
      inferLinearTeamKey([
        "ruven/eng-12-fix-login",
        "ENG-13: Fix the thing",
        "ENG-14: Another",
        "OPS-1: Rotate keys",
        "Bump UTF-8 handling",
      ]),
    ).toEqual({ key: "ENG", hits: 3 })
  })

  it("needs enough hits to call it a convention", () => {
    expect(inferLinearTeamKey(["ENG-1 once", "ENG-2 twice"])).toBeUndefined()
  })
})

describe("parseSentryConfig", () => {
  it("reads sentry.properties", () => {
    expect(
      parseSentryConfig(
        "defaults.org=acme\ndefaults.project=web\nauth.token=secret",
      ),
    ).toEqual({ org: "acme", project: "web" })
  })

  it("reads .sentryclirc sections", () => {
    expect(
      parseSentryConfig(
        "[auth]\ntoken=secret\n[defaults]\norg=acme\nproject=web\nurl=https://s.acme.dev",
      ),
    ).toEqual({ org: "acme", project: "web", url: "https://s.acme.dev" })
  })
})

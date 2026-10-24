import { describe, expect, it } from "vitest"
import { CAPABILITIES } from "../capabilities.ts"
import { checkConfig, exampleConfig } from "../config.ts"
import { toInstanceName, uniqueInstanceNames } from "../instances.ts"
import { OP_PLACEHOLDER, providersOf } from "../integrations.ts"
import type { FieldSpec } from "../types.ts"
import { parseGithubRemote } from "./github.ts"
import { parseGitlabRemote } from "./gitlab.ts"
import { parseGraphiteConfig } from "./graphite.ts"
import { INTEGRATIONS, SECTIONS } from "./index.ts"
import { inferJiraProject, jiraLinkedKeys } from "./jira.ts"
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
        // Reserved: it names an instance when the section is a list.
        expect(field.key).not.toBe("name")
        expect(typeOf(field.example)).toBe(field.type ?? "string")
      }
    },
  )

  it("accepts a config built from every section's examples", () => {
    expect(checkConfig(exampleConfig())).toEqual({ issues: [], warnings: [] })
  })
})

// What flows rely on when they ask for a capability instead of a vendor.
describe("integration registry", () => {
  it("has unique capability ids, each provided by some integration", () => {
    const ids = CAPABILITIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(providersOf(id).length, id).toBeGreaterThan(0)
    }
  })

  it("gives each leveled capability unique levels and a default among them", () => {
    for (const capability of CAPABILITIES.filter((c) => c.levels)) {
      const ids = capability.levels?.map((l) => l.id) ?? []
      expect(ids.length, capability.id).toBeGreaterThan(1)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toContain(capability.defaultLevel)
    }
  })

  it.each(INTEGRATIONS.map((s) => [s.path, s] as const))(
    "%s lives under integrations and implements every op it provides",
    (path, spec) => {
      expect(path).toMatch(/^integrations\.[a-z][a-zA-Z0-9]*$/)
      expect(Object.keys(spec.provides).length).toBeGreaterThan(0)
      const required = spec.fields.filter((f) => f.required).map((f) => f.key)
      for (const [id, ops] of Object.entries(spec.provides)) {
        const capability = CAPABILITIES.find((c) => c.id === id)
        expect(capability, `unknown capability ${id}`).toBeDefined()
        expect(Object.keys(ops).sort()).toEqual(
          Object.keys(capability?.ops ?? {}).sort(),
        )
        for (const [op, impl] of Object.entries(ops)) {
          const variants: [string, string][] =
            typeof impl === "string" ? [["any", impl]] : Object.entries(impl)
          expect(
            variants.length,
            `${path} ${op} has no variant`,
          ).toBeGreaterThan(0)
          for (const [kind, how] of variants) {
            // A variant needs its access declared, so it can be probed.
            if (kind !== "any") {
              expect(spec.access, `${path} ${op}.${kind}`).toHaveProperty(kind)
            }
            // Only API variants use the token, and only through {token}.
            if (how.includes("{token}")) {
              expect(kind, `${path} ${op} uses {token}`).toBe("api")
            }
            checkPlaceholders(how)
          }
        }
      }

      function checkPlaceholders(how: string): void {
        for (const [, key, fallback] of how.matchAll(OP_PLACEHOLDER)) {
          if (key === "token") {
            continue
          }
          const field = spec.fields.find((f) => f.key === key)
          expect(field, `${path} op uses unknown {${key}}`).toBeDefined()
          // Always set, or given a default for when it isn't.
          if (!fallback) {
            expect(required, `${path} op uses optional {${key}}`).toContain(key)
          }
          // Values land in shell commands from a committed file.
          expect(field?.pattern, `${path}.${key} has no pattern`).toBeDefined()
          for (const hostile of SHELL_HOSTILE) {
            expect(field?.pattern?.regex.test(hostile), hostile).toBe(false)
          }
        }
      }
    },
  )

  it.each(INTEGRATIONS.map((s) => [s.path, s] as const))(
    "%s has adapters only for its ops, reached through access it declares",
    (path, spec) => {
      const ops = Object.values(spec.provides).flatMap((o) => Object.keys(o))
      for (const [op, adapter] of Object.entries(spec.adapters ?? {})) {
        expect(ops, `${path} adapter ${op}`).toContain(op)
        if (adapter.needs) {
          expect(spec.access, `${path} adapter ${op}`).toHaveProperty(
            adapter.needs,
          )
        }
      }
    },
  )

  it.each(INTEGRATIONS.map((s) => [s.path, s] as const))(
    "%s declares at least one way to reach it",
    (_path, spec) => {
      expect(Object.keys(spec.access).length).toBeGreaterThan(0)
      if (spec.access.cli?.auth) {
        expect(spec.access.cli.auth[0]).toBe(spec.access.cli.bin)
      }
      for (const name of spec.access.api?.token ?? []) {
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
      }
    },
  )
})

const SHELL_HOSTILE = [
  "web$(touch x)",
  "web`id`",
  "web;id",
  "web id",
  "web'x",
  'web"x',
  "web|id",
  "web&id",
  "web\nid",
  "web>x",
  "acme/web$(id)",
  "gitlab.acme.dev;id",
]

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

describe("parseGitlabRemote", () => {
  it.each([
    ["git@gitlab.com:acme/web.git", { project: "acme/web" }],
    ["https://gitlab.com/acme/platform/web", { project: "acme/platform/web" }],
    [
      "ssh://git@gitlab.acme.dev:2222/acme/web.git",
      { project: "acme/web", host: "gitlab.acme.dev" },
    ],
    // An HTTP port is part of the web host; an SSH one isn't.
    [
      "https://gitlab.acme.dev:8443/g/web",
      { project: "g/web", host: "gitlab.acme.dev:8443" },
    ],
    ["https://GitLab.com/g/web", { project: "g/web" }],
    [
      "https://gitlab.com/acme/platform/web.git/",
      { project: "acme/platform/web" },
    ],
    // An SSH alias hides the real host.
    [
      "git@gitlab-work:group/web.git",
      { project: "group/web", alias: "gitlab-work" },
    ],
  ])("parses %s", (url, expected) => {
    expect(parseGitlabRemote(url)).toEqual(expected)
  })

  it.each([
    "git@github.com:acme/web.git",
    // Userinfo that mentions gitlab isn't the host.
    "https://gitlab-ci-token:abc@github.com/acme/web.git",
    "https://gitlab.com/web",
  ])("ignores %s", (url) => {
    expect(parseGitlabRemote(url)).toBeUndefined()
  })
})

describe("inferJiraProject", () => {
  it("picks the most linked site and project", () => {
    expect(
      inferJiraProject([
        "Fixes https://acme.atlassian.net/browse/SUP-12",
        "See acme.atlassian.net/browse/SUP-13 and acme.atlassian.net/browse/OPS-1",
        "No link here",
      ]),
    ).toEqual({ site: "acme.atlassian.net", projectKey: "SUP", hits: 2 })
    expect(inferJiraProject(["ENG-12 without a link"])).toBeUndefined()
    expect(
      inferJiraProject(["acme.atlassian.net/browse/MY_PROJ-12"])?.projectKey,
    ).toBe("MY_PROJ")
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
  it("ignores keys the team links to Jira", () => {
    expect(
      inferLinearTeamKey(
        ["SUP-1: a", "SUP-2: b", "SUP-3: c"],
        3,
        jiraLinkedKeys(["acme.atlassian.net/browse/SUP-1"]),
      ),
    ).toBeUndefined()
  })

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

describe("instance names", () => {
  it("slugs anything into a valid name", () => {
    expect(toInstanceName("Apps/Web App")).toBe("apps-web-app")
    expect(toInstanceName("a:b")).toBe("a-b")
    expect(toInstanceName("///")).toBe("default")
  })

  it("falls back on collisions, then numbers", () => {
    expect(
      uniqueInstanceNames([
        { preferred: "web", fallback: "apps/web" },
        { preferred: "web", fallback: "packages/web" },
        { preferred: "docs", fallback: "apps/docs" },
        { preferred: "x", fallback: "same" },
        { preferred: "x", fallback: "same" },
      ]),
    ).toEqual(["apps-web", "packages-web", "docs", "same", "same-2"])
    // A suffix never lands on a name that's already used.
    expect(
      uniqueInstanceNames([
        { preferred: "web", fallback: "apps/web" },
        { preferred: "web", fallback: "apps-web" },
        { preferred: "apps-web-2", fallback: "x" },
      ]),
    ).toEqual(["apps-web", "apps-web-2", "apps-web-2-2"])
  })
})

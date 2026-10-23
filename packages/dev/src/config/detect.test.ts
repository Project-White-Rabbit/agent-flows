import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createDetectContext,
  dependencyNames,
  detectSections,
  pythonDependencyNames,
} from "./detect.ts"

describe("dependencyNames", () => {
  it("collects every dependency field", () => {
    expect(
      dependencyNames(
        JSON.stringify({
          dependencies: { "@sentry/nextjs": "1" },
          devDependencies: { vercel: "1" },
        }),
      ),
    ).toEqual(["@sentry/nextjs", "vercel"])
  })
})

describe("detect", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("finds services from git metadata and local files", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-detect-"))
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir as string, ...args], { stdio: "pipe" })
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir as string, file)), {
        recursive: true,
      })
      fs.writeFileSync(path.join(dir as string, file), content)
    }
    git("init", "-q", "-b", "main")
    git("remote", "add", "origin", "git@github.com:acme/web.git")
    write(
      "apps/web/package.json",
      JSON.stringify({ dependencies: { "@sentry/nextjs": "1" } }),
    )
    write(
      "apps/web/.vercel/project.json",
      JSON.stringify({ orgId: "team_1", projectId: "prj_1" }),
    )
    write(".neon", JSON.stringify({ projectId: "dry-sun-1" }))
    write(".env.example", "POSTHOG_HOST=https://eu.posthog.com\n")
    write(".env", "SENTRY_AUTH_TOKEN=should-never-be-read\nNEON=neon.tech\n")
    git("add", "apps/web/package.json", ".env.example")
    for (const n of [1, 2, 3]) {
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        `ENG-${n}: change`,
      )
    }

    const found = detectSections(createDetectContext(dir))
    expect(found["integrations.github"]?.values).toEqual({
      owner: "acme",
      repo: "web",
    })
    expect(found["integrations.linear"]?.values).toEqual({
      teamKey: "ENG",
    })
    expect(found["integrations.vercel"]?.values).toEqual({
      team: "team_1",
      project: "prj_1",
      directory: "apps/web",
    })
    expect(found["integrations.vercel"]?.instances).toBeUndefined()
    expect(found["integrations.neon"]?.values).toEqual({
      projectId: "dry-sun-1",
    })
    expect(found["integrations.posthog"]?.values).toEqual({
      host: "https://eu.posthog.com",
    })
    expect(found["integrations.sentry"]?.evidence).toEqual([
      "apps/web/package.json depends on @sentry/nextjs",
    ])
    expect(found.repo?.values).toEqual({ baseBranch: "main" })
    expect(JSON.stringify(found)).not.toContain("should-never-be-read")
  })

  it("finds one Vercel instance per linked app", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-detect-"))
    const root = dir
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), content)
    }
    execFileSync("git", ["-C", root, "init", "-q"])
    for (const app of ["apps/web", "apps/docs", "packages/web"]) {
      write(`${app}/package.json`, "{}")
      write(
        `${app}/.vercel/project.json`,
        JSON.stringify({
          orgId: "team_1",
          projectId: `prj_${app.replace("/", "_")}`,
        }),
      )
    }
    execFileSync("git", ["-C", root, "add", "apps", "packages"])
    const vercel = detectSections(createDetectContext(root))[
      "integrations.vercel"
    ]
    // Two apps called web: the full path tells them apart.
    expect(vercel?.instances?.map((i) => [i.name, i.directory])).toEqual([
      ["docs", "apps/docs"],
      ["apps-web", "apps/web"],
      ["packages-web", "packages/web"],
    ])
    expect(vercel?.values).toEqual({
      team: "team_1",
      project: "prj_apps_docs",
      directory: "apps/docs",
    })
  })
})

describe("pythonDependencyNames", () => {
  it("reads requirements files", () => {
    expect(
      pythonDependencyNames(
        "requirements.txt",
        "# comment\nsentry-sdk[fastapi]==2.0\n-r base.txt\nPostHog>=3\n",
      ),
    ).toEqual(["sentry-sdk", "posthog"])
  })

  it("reads pyproject list items and poetry dependency tables", () => {
    const pyproject = [
      "[project]",
      'name = "api"',
      "dependencies = [",
      '  "sentry-sdk>=2",',
      "]",
      "[tool.poetry.dependencies]",
      'python = "^3.12"',
      'posthog = "^3"',
    ].join("\n")
    expect(pythonDependencyNames("api/pyproject.toml", pyproject)).toEqual([
      "sentry-sdk",
      "posthog",
    ])
  })
})

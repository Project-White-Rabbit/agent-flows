import { describe, expect, it } from "vitest"
import { routedProjects } from "../commands/sync.ts"
import { checkConfig } from "./config.ts"
import { checkProjects, projectName, routeProject } from "./projects.ts"

const check = (value: unknown) => {
  const warnings: string[] = []
  return { issues: checkProjects(value, "p", warnings), warnings }
}

describe("checkProjects", () => {
  it("takes names and named path routes", () => {
    expect(
      check([
        "Platform",
        { name: "Mobile", paths: ["apps/mobile/**"] },
        { name: "Docs" },
      ]),
    ).toEqual({ issues: [], warnings: [] })
  })

  it("rejects an empty list, bad items, and repeats", () => {
    expect(check([]).issues).toEqual(["p must be a non-empty list of projects"])
    expect(check("Mobile").issues).toEqual([
      "p must be a non-empty list of projects",
    ])
    expect(
      check([3, " ", { paths: ["a/**"] }, { name: "Web", paths: [] }, "web"])
        .issues,
    ).toEqual([
      'p[0] must be a project\'s name, or { "name", "paths" }',
      "p[1] must be a project's name",
      "p[2].name must be a project's name",
      "p[3].paths must be a list of non-empty globs",
      'p lists "web" twice',
    ])
  })

  it("keeps fields a newer plugin may know, with a warning", () => {
    expect(check([{ name: "Web", labels: ["x"] }]).warnings).toEqual([
      'unknown field "p[0].labels" (kept as is; it may come from a newer plugin)',
    ])
  })
})

describe("projectName", () => {
  it("reads both forms", () => {
    expect(projectName("Web")).toBe("Web")
    expect(projectName({ name: "Mobile", paths: ["m/**"] })).toBe("Mobile")
  })
})

describe("routeProject", () => {
  const projects = [
    "Platform",
    { name: "Web", paths: ["apps/web/**", "packages/ui/**"] },
    { name: "Mobile", paths: ["apps/mobile/**"] },
  ]

  it("picks the project whose paths match the most changed files", () => {
    expect(
      routeProject(projects, [
        "apps/mobile/a.ts",
        "apps/mobile/b.ts",
        "apps/web/c.ts",
        "README.md",
      ]),
    ).toEqual({ project: "Mobile", files: 2 })
  })

  it("takes the first listed on a tie, and names the others", () => {
    expect(
      routeProject(projects, ["packages/ui/x.tsx", "apps/mobile/y.ts"]),
    ).toEqual({ project: "Web", files: 1, tied: ["Mobile"] })
  })

  it("is undefined when nothing matches, or nothing claims paths", () => {
    expect(routeProject(projects, ["README.md"])).toBeUndefined()
    expect(routeProject(["Platform"], ["apps/web/a.ts"])).toBeUndefined()
    expect(routeProject(undefined, ["apps/web/a.ts"])).toBeUndefined()
  })
})

describe("the projects field", () => {
  const config = (projects: unknown) => ({
    version: 2,
    repo: { baseBranch: "main" },
    integrations: {
      linear: { teamKey: "ENG", project: "Platform", projects },
    },
  })

  it("is valid on Linear", () => {
    expect(
      checkConfig(config(["Web", { name: "Mobile", paths: ["m/**"] }])).issues,
    ).toEqual([])
  })

  it("reports a bad list at its path", () => {
    expect(
      checkConfig(config([{ name: "Mobile", paths: "m/**" }])).issues,
    ).toEqual([
      "integrations.linear.projects[0].paths must be a list of non-empty globs",
    ])
  })
})

describe("routedProjects", () => {
  it("routes each tracker entry that claims paths, by instance or integration", () => {
    const config = {
      integrations: {
        linear: [
          {
            name: "product",
            teamKey: "ENG",
            projects: [{ name: "Mobile", paths: ["apps/mobile/**"] }],
          },
          { name: "ops", teamKey: "OPS", projects: ["Infra"] },
          {
            name: "web",
            teamKey: "WEB",
            projects: [{ name: "Site", paths: ["apps/site/**"] }],
          },
        ],
        // GitHub tracks issues only on opt-in.
        github: [
          {
            name: "app",
            owner: "acme",
            repo: "app",
            projects: [{ name: "Roadmap", paths: ["apps/**"] }],
          },
          {
            name: "issues",
            owner: "acme",
            repo: "issues",
            use: { issueTracker: "track" },
            projects: [{ name: "Board", paths: ["apps/**"] }],
          },
        ],
      },
    }
    expect(routedProjects(config, () => ["apps/mobile/a.ts"])).toEqual({
      product: { project: "Mobile", files: 1 },
      web: null,
      issues: { project: "Board", files: 1 },
    })
  })

  it("reads no files when no entry claims paths", () => {
    let read = false
    expect(
      routedProjects(
        { integrations: { linear: { teamKey: "ENG", projects: ["Web"] } } },
        () => {
          read = true
          return []
        },
      ),
    ).toEqual({})
    expect(read).toBe(false)
    expect(routedProjects(undefined, () => [])).toEqual({})
  })
})

import { describe, expect, it } from "vitest"
import type { SessionContext } from "../../config/types.ts"
import { superset, supersetProject } from "./spec.ts"

// A Superset project id belongs to one Superset organization and each
// machine's setup of it, so the config holds none: each machine finds its own.
describe("superset's project on this machine", () => {
  const MAIN = "/Users/sam/code/web"
  const ROOT = "/Users/sam/.superset/worktrees/web/fix-login"
  const project = (id: string, path: string, repo: string) => ({
    name: path.split("/").at(-1),
    repo,
    path,
    id,
  })

  function session(projects: unknown[] | undefined): SessionContext {
    return {
      env: {},
      root: ROOT,
      run: async (command) => {
        const line = command.join(" ")
        if (line === "git rev-parse --path-format=absolute --git-common-dir") {
          return `${MAIN}/.git\n`
        }
        if (line === "git remote get-url origin") {
          return "https://github.com/acme/web.git\n"
        }
        return line === "superset projects list --local --json" && projects
          ? JSON.stringify(projects)
          : undefined
      },
    }
  }

  it("finds the project set up at the main checkout", async () => {
    expect(
      await supersetProject(
        session([
          project(
            "p-api",
            "/Users/sam/code/api",
            "https://github.com/acme/api",
          ),
          project("p-web", MAIN, "https://github.com/acme/web"),
        ]),
      ),
    ).toEqual({ values: { project: "p-web" } })
  })

  it("finds it by origin when it's set up at another path", async () => {
    expect(
      await supersetProject(
        session([
          project("p-web", "/elsewhere/web", "git@github.com:Acme/web"),
        ]),
      ),
    ).toEqual({ values: { project: "p-web" } })
  })

  it("never targets another repository's project", async () => {
    const got = await supersetProject(
      session([
        project("p-api", "/Users/sam/code/api", "https://github.com/acme/api"),
      ]),
    )
    expect(got).toEqual({
      problem: expect.stringContaining(`--import ${MAIN}`),
    })
  })

  it("says what to check when it can't list projects", async () => {
    expect(await supersetProject(session(undefined))).toEqual({
      problem: expect.stringContaining("superset auth whoami"),
    })
  })

  it("keeps no project id in the config", () => {
    expect(superset.fields.map((f) => f.key)).toEqual(["agent", "browser"])
    expect(superset.machine?.keys).toEqual(["project"])
  })
})

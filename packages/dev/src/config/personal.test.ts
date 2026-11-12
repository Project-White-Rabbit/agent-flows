// Values that are true only for one person or machine stay out of the
// committed config, or warn when they're in it.
import { describe, expect, it } from "vitest"
import { claude } from "../integrations/claude/spec.ts"
import {
  conductor,
  conductorProject,
  conductorProjectIn,
} from "../integrations/conductor/spec.ts"
import { github } from "../integrations/github/spec.ts"
import { gitlab } from "../integrations/gitlab/spec.ts"
import { vercel } from "../integrations/vercel/spec.ts"
import {
  portableDirectory,
  worktreeDirectory,
} from "../integrations/worktree/spec.ts"
import { CONFIG_VERSION, checkConfig, overlay } from "./config.ts"
import type { DetectContext, SessionContext } from "./types.ts"

const base = { version: CONFIG_VERSION, repo: { baseBranch: "main" } }

function context(
  remotes: Record<string, string>,
  extra: Partial<DetectContext> = {},
): DetectContext {
  return {
    env: {},
    tracked: [],
    packageDirs: [],
    envTemplates: [],
    dependsOn: () => [],
    read: () => undefined,
    readJson: () => undefined,
    git: (args: string[]) =>
      args[0] === "remote" && args[1] === "get-url"
        ? remotes[args[2]]
        : undefined,
    ...extra,
  } as unknown as DetectContext
}

describe("the team's repository, not a person's fork", () => {
  const fork = {
    origin: "git@github.com:sam/web.git",
    upstream: "https://github.com/acme/web.git",
  }

  it("detects GitHub's upstream over a fork's origin", () => {
    expect(github.detect?.(context(fork))).toEqual({
      values: { owner: "acme", repo: "web" },
      evidence: [expect.stringContaining("upstream remote")],
    })
  })

  it("detects origin when there's no upstream", () => {
    expect(github.detect?.(context({ origin: fork.origin }))?.values).toEqual({
      owner: "sam",
      repo: "web",
    })
  })

  it("does the same for GitLab and the Claude action", () => {
    expect(
      gitlab.detect?.(
        context({
          origin: "git@gitlab.com:sam/web.git",
          upstream: "git@gitlab.com:acme/web.git",
        }),
      )?.values,
    ).toMatchObject({ project: "acme/web" })
    const workflow =
      "on:\n  issue_comment:\njobs:\n  x:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n"
    const found = claude.detect?.(
      context(fork, {
        tracked: [".github/workflows/claude.yml"],
        read: () => workflow,
      }),
    )
    expect(found?.values).toMatchObject({ owner: "acme", repo: "web" })
  })
})

describe("git worktree directories", () => {
  const HOME = "/Users/sam"
  const MAIN = "/Users/sam/code/web"

  it("records one beside or inside the checkout relative to it", () => {
    expect(portableDirectory(MAIN, "/Users/sam/code/web-worktrees", HOME)).toBe(
      "../web-worktrees",
    )
    expect(portableDirectory(MAIN, `${MAIN}/.worktrees`, HOME)).toBe(
      ".worktrees",
    )
  })

  it("records one further away from the home folder, never by name", () => {
    expect(portableDirectory(MAIN, "/Users/sam/wt/web", HOME)).toBe("~/wt/web")
    expect(portableDirectory(MAIN, "/Volumes/scratch/web", HOME)).toBe(
      undefined,
    )
  })

  it("detects it portably", () => {
    const porcelain = `worktree ${MAIN}\n\nworktree /Users/sam/wt/web/a\n\nworktree /Users/sam/wt/web/b\n`
    expect(worktreeDirectory(porcelain, HOME)).toBe("~/wt/web")
  })

  it("warns about one committed in a home folder or far outside the checkout", () => {
    const warns = (directory: string) =>
      checkConfig({
        ...base,
        integrations: { worktree: { directory } },
      }).warnings
    expect(warns("/Users/sam/wt")).toEqual([
      expect.stringContaining("home folder"),
    ])
    expect(warns("../../../tmp/wt")).toEqual([
      expect.stringContaining("climbs out"),
    ])
    expect(warns("/srv/worktrees")).toEqual([
      expect.stringContaining("absolute"),
    ])
    expect(warns("../web-worktrees")).toEqual([])
    expect(warns("~/worktrees/web")).toEqual([])
  })
})

describe("other personal values", () => {
  it("warns about a Slack DM or a person as the channel", () => {
    const warns = (channel: string) =>
      checkConfig({ ...base, integrations: { slack: { channel } } }).warnings
    expect(warns("D0123ABCD45")).toHaveLength(1)
    expect(warns("U0123ABCD45")).toHaveLength(1)
    expect(warns("#eng")).toEqual([])
    expect(warns("C0123ABCD45")).toEqual([])
  })

  it("warns about a hook that runs something in a home folder", () => {
    const { issues, warnings } = checkConfig({
      ...base,
      finish: {
        before: [{ name: "lint", run: "/Users/sam/bin/lint.sh" }],
      },
    })
    expect(issues).toEqual([])
    expect(warnings).toEqual([expect.stringContaining("home folder")])
  })

  it("records no team for a Vercel project linked to a personal account", () => {
    const found = vercel.detect?.(
      context(
        {},
        {
          packageDirs: [""],
          readJson: (file: string) =>
            file === ".vercel/project.json"
              ? { orgId: "AbC123personal", projectId: "prj_1" }
              : undefined,
        },
      ),
    )
    expect(found?.values).toEqual({ project: "prj_1" })
    expect(found?.evidence).toContainEqual(
      expect.stringContaining("personal Vercel account"),
    )
  })
})

describe("a personal field in this machine's override", () => {
  it("lays the override over the committed section field by field", () => {
    const shared = {
      ...base,
      integrations: { orca: { use: { workspaces: true }, agent: "claude" } },
    }
    const { config } = overlay(shared, {
      version: CONFIG_VERSION,
      integrations: { orca: { agent: "codex" } },
    })
    expect(config.integrations).toEqual({
      orca: { use: { workspaces: true }, agent: "codex" },
    })
  })

  it("still replaces a section configured as a list whole", () => {
    const shared = {
      ...base,
      integrations: {
        vercel: [
          { name: "web", project: "prj_web" },
          { name: "docs", project: "prj_docs" },
        ],
      },
    }
    const mine = [{ name: "web", project: "prj_mine" }]
    const { config } = overlay(shared, {
      version: CONFIG_VERSION,
      integrations: { vercel: mine },
    })
    expect((config.integrations as { vercel: unknown }).vercel).toEqual(mine)
  })
})

describe("conductor's project on this machine", () => {
  const checkout = {
    root: "/Users/sam/code/web",
    main: "/Users/sam/code/web",
    origin: "git@github.com:acme/web.git",
  }
  const list = JSON.stringify([
    { id: "proj_api", name: "api", repository: "acme/api" },
    {
      id: "proj_web",
      name: "web",
      repository: { url: "https://github.com/acme/web" },
    },
  ])

  it("uses the team's projectId when this account can see it", () => {
    expect(conductorProjectIn(list, checkout, "proj_api")).toEqual({
      values: { projectId: "proj_api" },
    })
  })

  it("finds the project for origin otherwise, by URL or owner/repo", () => {
    expect(conductorProjectIn(list, checkout)).toEqual({
      values: { projectId: "proj_web" },
    })
    expect(
      conductorProjectIn(
        JSON.stringify({ projects: [{ id: "p2", repo: "Acme/Web" }] }),
        checkout,
      ),
    ).toEqual({ values: { projectId: "p2" } })
  })

  it("never targets another repository for an id from another organization", () => {
    const got = conductorProjectIn(
      JSON.stringify([{ id: "proj_api", repository: "acme/api" }]),
      checkout,
      "proj_elsewhere",
    )
    expect(got).toEqual({
      problem: expect.stringContaining("another organization"),
    })
  })

  it("tries the app's own CLI when conductor isn't on PATH", async () => {
    const tried: string[] = []
    const session: SessionContext = {
      env: {},
      root: checkout.root,
      run: async (command) => {
        const line = command.join(" ")
        if (line.startsWith("git rev-parse")) {
          return `${checkout.main}/.git\n`
        }
        if (line.startsWith("git remote")) {
          return `${checkout.origin}\n`
        }
        tried.push(command[0])
        return command[0] === "conductor" ? undefined : list
      },
    }
    expect(await conductorProject(session, {})).toEqual({
      values: { projectId: "proj_web" },
    })
    expect(tried).toHaveLength(2)
  })

  it("keeps projectId optional", () => {
    expect(conductor.fields.find((f) => f.key === "projectId")?.required).toBe(
      undefined,
    )
    expect(conductor.machine?.keys).toEqual(["projectId"])
  })
})

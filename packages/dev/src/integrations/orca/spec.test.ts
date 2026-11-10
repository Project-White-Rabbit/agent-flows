import { describe, expect, it } from "vitest"
import type { DetectContext, SessionContext } from "../../config/types.ts"
import { remoteKey } from "../local-repo.ts"
import { superset } from "../superset/spec.ts"
import { worktreeDirectory } from "../worktree/spec.ts"
import { orca, orcaRepo, paneRepo } from "./spec.ts"

const PORCELAIN = `worktree /Users/sam/code/web
HEAD 9cd963e
branch refs/heads/main

worktree /Users/sam/orca/workspaces/web/ruffe
HEAD 273bb26
branch refs/heads/sam/fix-login

worktree /Users/sam/orca/workspaces/web/heron
HEAD 41aa0c2
branch refs/heads/sam/add-search
`

function checkout(
  porcelain: string,
  env: Record<string, string> = {},
): DetectContext {
  return {
    env,
    git: (args: string[]) =>
      args.join(" ") === "worktree list --porcelain" ? porcelain : undefined,
  } as unknown as DetectContext
}

describe("orca", () => {
  it("detects the worktrees Orca checked out", () => {
    expect(orca.detect?.(checkout(PORCELAIN))).toEqual({
      values: {},
      evidence: ["2 git worktree(s) in Orca's default folder"],
    })
  })

  it("detects Orca from inside it, wherever its worktrees are", () => {
    expect(
      orca.detect?.(
        checkout("worktree /Users/sam/code/web\n", { ORCA_WORKTREE_ID: "x" }),
      ),
    ).toEqual({ values: {}, evidence: ["this session runs in Orca"] })
  })

  it("finds nothing in a repo Orca never touched", () => {
    expect(
      orca.detect?.(checkout("worktree /Users/sam/code/web\n")),
    ).toBeUndefined()
  })

  it("has a browser, like Superset", () => {
    expect(Object.keys(orca.provides)).toContain("browser")
    expect(Object.keys(superset.provides)).toContain("browser")
  })

  it("keeps Orca's worktrees out of the repo's own worktree directory", () => {
    expect(worktreeDirectory(PORCELAIN)).toBeUndefined()
  })
})

// Orca's repo ids are made by each machine's app, so the config holds none:
// each machine finds its own, and never another repository's.
describe("orca's repo on this machine", () => {
  const MAIN = "/Users/sam/code/web"
  const ROOT = "/Users/sam/orca/workspaces/web/ruffe"
  const ORIGIN = "git@github.com:Acme/web.git"
  const repo = (id: string, path: string, canonicalKey: string) => ({
    id,
    path,
    displayName: path.split("/").at(-1),
    gitRemoteIdentity: {
      canonicalKey,
      remoteName: "origin",
      remoteUrl: `https://${canonicalKey}.git`,
    },
  })
  const listing = (...repos: unknown[]) =>
    JSON.stringify({ ok: true, result: { repos } })

  function session(
    orca: string | undefined,
    env: Record<string, string> = {},
    { origin = ORIGIN }: { origin?: string } = {},
  ) {
    const calls: string[] = []
    const ctx: SessionContext = {
      env,
      root: ROOT,
      run: async (command) => {
        const line = command.join(" ")
        calls.push(line)
        if (line === "git rev-parse --path-format=absolute --git-common-dir") {
          return `${MAIN}/.git\n`
        }
        if (line === "git remote get-url origin") {
          return origin ? `${origin}\n` : undefined
        }
        return line === "orca repo list --json" ? orca : undefined
      },
    }
    return { ctx, calls }
  }

  it("takes the repo of the Orca pane this session runs in", async () => {
    const { ctx, calls } = session(undefined, {
      ORCA_WORKTREE_ID: `11aa22bb::${ROOT}`,
    })
    expect(await orcaRepo(ctx)).toEqual({ values: { repo: "id:11aa22bb" } })
    expect(calls).not.toContain("orca repo list --json")
  })

  it("finds the repo Orca added at the main checkout", async () => {
    const { ctx } = session(
      listing(
        repo("other", "/Users/sam/code/api", "github.com/Acme/api"),
        repo("mine", MAIN, "github.com/Acme/web"),
      ),
    )
    expect(await orcaRepo(ctx)).toEqual({ values: { repo: "id:mine" } })
  })

  it("finds it by origin when Orca added another clone of it", async () => {
    const { ctx } = session(
      listing(
        repo("other", "/Users/sam/code/api", "github.com/Acme/api"),
        repo("clone", "/Volumes/work/web", "github.com/acme/web"),
      ),
    )
    expect(await orcaRepo(ctx)).toEqual({ values: { repo: "id:clone" } })
  })

  it("matches origin in any of its URL forms", async () => {
    const { ctx } = session(
      listing(repo("clone", "/elsewhere", "github.com/Acme/web")),
      {},
      { origin: "ssh://git@github.com:22/acme/web" },
    )
    expect(await orcaRepo(ctx)).toEqual({ values: { repo: "id:clone" } })
  })

  it("ignores a pane of another repository and looks it up instead", async () => {
    const { ctx } = session(
      listing(repo("mine", MAIN, "github.com/Acme/web")),
      {
        ORCA_WORKTREE_ID: "foreign::/Users/sam/orca/workspaces/api/heron",
      },
    )
    expect(await orcaRepo(ctx)).toEqual({ values: { repo: "id:mine" } })
  })

  it("ignores the floating terminal's id", async () => {
    const { ctx } = session(
      listing(repo("mine", MAIN, "github.com/Acme/web")),
      {
        ORCA_WORKTREE_ID: "global-floating-terminal",
      },
    )
    expect(await orcaRepo(ctx)).toEqual({ values: { repo: "id:mine" } })
  })

  it("never targets another repository when Orca hasn't added this one", async () => {
    // A teammate's id, or another repo's, matches nothing here.
    const { ctx, calls } = session(
      listing(repo("66ee3232", "/Users/sam/code/api", "github.com/Acme/api")),
    )
    const got = await orcaRepo(ctx)
    expect(got).not.toHaveProperty("values")
    expect(got).toEqual({
      problem: expect.stringContaining(`orca repo add --path ${MAIN}`),
    })
    expect(calls.filter((c) => c.startsWith("orca repo add"))).toEqual([])
  })

  it("won't pick between two clones of it Orca added elsewhere", async () => {
    const { ctx } = session(
      listing(
        repo("a", "/one/web", "github.com/Acme/web"),
        repo("b", "/two/web", "github.com/Acme/web"),
      ),
    )
    expect(await orcaRepo(ctx)).toEqual({
      problem: expect.stringContaining("several repos"),
    })
  })

  it("passes on no id that isn't safe in a shell command", async () => {
    const { ctx } = session(
      listing(repo("$(rm -rf ~)", MAIN, "github.com/Acme/web")),
      {
        ORCA_WORKTREE_ID: `x;y::${ROOT}`,
      },
    )
    expect(await orcaRepo(ctx)).toHaveProperty("problem")
  })

  it("says Orca must be running when it can't list its repos", async () => {
    const { ctx } = session(undefined)
    expect(await orcaRepo(ctx)).toEqual({
      problem: expect.stringContaining("orca open"),
    })
  })

  it("keeps no repo id in the config, and fills its ops with this machine's", () => {
    expect(orca.fields.map((f) => f.key)).toEqual(["agent"])
    const ops = Object.values(orca.provides.workspaces)
      .map((op) => (op as { cli: string }).cli)
      .join("\n")
    expect(ops).not.toContain("id:{repo}")
    expect(ops).toContain("--repo {repo}")
    expect(orca.machine?.keys).toEqual(["repo"])
  })

  it("reads the pane id as <repo id>::<path>", () => {
    expect(paneRepo(`r1::${MAIN}`, { root: ROOT, main: MAIN })).toBe("r1")
    expect(paneRepo(undefined, { root: ROOT })).toBeUndefined()
  })
})

describe("remoteKey", () => {
  it("reads every URL form of a remote the same", () => {
    for (const url of [
      "git@github.com:Acme/web.git",
      "https://github.com/acme/web",
      "https://token@github.com/Acme/web.git/",
      "ssh://git@github.com:22/Acme/web.git",
    ]) {
      expect(remoteKey(url), url).toBe("github.com/acme/web")
    }
    expect(remoteKey("")).toBeUndefined()
  })
})

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEV_FLOWS_FRONT_ENDS,
  renderDevFlowsFrontEnd,
  renderFrontEndTemplates,
} from "../flows/index.ts"
import { fill, planFrontEnd, readTemplates } from "./front-end.ts"
import { UsageError } from "./lib.ts"

const packageDir = path.resolve(import.meta.dirname, "..", "..")
const script = path.join(packageDir, "src", "commands", "front-end.ts")
const templates = readTemplates(packageDir)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true })
})

function frontEnd(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "front-end-"))
  dirs.push(dir)
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
  return dir
}

function write(dir: string, ...extra: string[]) {
  return spawnSync(
    "node",
    [
      script,
      "write",
      "--plugin",
      "team-dev",
      "--marketplace",
      "team",
      "--dir",
      dir,
      ...extra,
    ],
    { encoding: "utf8" },
  )
}

describe("front-end templates", () => {
  it("fill in to exactly what the build writes for a front end", () => {
    const shipped = renderDevFlowsFrontEnd()
    expect(
      renderFrontEndTemplates().filter((file) => file.target === "claude"),
    ).toHaveLength(shipped.length)
    for (const file of shipped) {
      const template = templates.get(file.flowId)
      expect(template, file.flowId).toBeDefined()
      expect(fill(template ?? "", "dev-flows", "agent-flows")).toBe(
        file.content,
      )
    }
  })
})

describe("front-end templates for other hosts", () => {
  for (const { host } of DEV_FLOWS_FRONT_ENDS.filter(
    (f) => f.host !== "claude",
  )) {
    it(`fill in to exactly what the build writes for ${host}`, () => {
      const hostTemplates = readTemplates(packageDir, host)
      for (const file of renderDevFlowsFrontEnd(host)) {
        expect(
          fill(
            hostTemplates.get(file.flowId) ?? "",
            "dev-flows",
            "agent-flows",
          ),
          file.flowId,
        ).toBe(file.content)
      }
    })
  }

  it("writes Cursor wrappers as <plugin>-<flow> skills, leaving its own alone", () => {
    const dir = frontEnd({ "skills/team-dev-sync/SKILL.md": "our own sync\n" })
    const result = write(dir, "--host", "cursor", "--exclude", "sync")
    expect(result.status).toBe(0)
    const out = JSON.parse(result.stdout)
    expect(out.own).toEqual(["sync"])
    const ready = fs.readFileSync(
      path.join(dir, "skills", "team-dev-ready", "SKILL.md"),
      "utf8",
    )
    expect(ready).toContain("name: team-dev-ready")
    expect(ready).toContain("# /team-dev-ready")
    expect(ready).toContain("flows/cursor/ready/flow.md")
    expect(ready).not.toContain("__FRONT_END")
    const again = write(dir, "--host", "cursor")
    expect(again.status).toBe(2)
    expect(again.stderr).toContain("--exclude sync")
  })

  it("writes Codex wrappers invoked as $<plugin>:<flow>", () => {
    const dir = frontEnd()
    expect(write(dir, "--host", "codex").status).toBe(0)
    const sync = fs.readFileSync(
      path.join(dir, "skills", "sync", "SKILL.md"),
      "utf8",
    )
    expect(sync).toContain("name: sync")
    expect(sync).toContain("# $team-dev:sync")
    expect(sync).toContain("its commands are `$team-dev:<name>`")
    expect(sync).toContain("codex plugin marketplace add")
  })

  it("rejects an unknown host", () => {
    const result = write(frontEnd(), "--host", "vim")
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("--host must be one of")
  })
})

describe("front-end.ts", () => {
  it("writes a wrapper per flow under the front end's names", () => {
    const dir = frontEnd()
    const result = write(dir)
    expect(result.status).toBe(0)
    const out = JSON.parse(result.stdout)
    expect(out.written).toEqual([...templates.keys()])
    const sync = fs.readFileSync(
      path.join(dir, "skills", "sync", "SKILL.md"),
      "utf8",
    )
    expect(sync).toContain("# /team-dev:sync")
    expect(sync).toContain("claude plugin update team-dev@team")
    expect(sync).toContain("claude plugin install dev-flows-base@agent-flows")
    expect(sync).not.toContain("__FRONT_END")
    expect(JSON.parse(write(dir).stdout).unchanged).toHaveLength(templates.size)
  })

  it("keeps the front end's own version of an excluded flow", () => {
    const dir = frontEnd({ "skills/sync/SKILL.md": "our own sync\n" })
    const result = write(dir, "--exclude", "sync")
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).own).toEqual(["sync"])
    expect(result.stderr).toBe("")
    expect(
      fs.readFileSync(path.join(dir, "skills", "sync", "SKILL.md"), "utf8"),
    ).toBe("our own sync\n")
  })

  it("refuses to overwrite a skill it didn't write", () => {
    const dir = frontEnd({ "skills/sync/SKILL.md": "our own sync\n" })
    const result = write(dir)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("--exclude sync")
  })

  it("refuses to shadow a command file of the same name", () => {
    const dir = frontEnd({ "commands/sync.md": "our sync\n" })
    const result = write(dir)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("commands/sync.md")
    expect(fs.existsSync(path.join(dir, "skills"))).toBe(false)
  })

  it("removes its wrapper for a newly excluded flow and warns nothing answers it", () => {
    const dir = frontEnd()
    write(dir)
    const result = write(dir, "--exclude", "cancel")
    const out = JSON.parse(result.stdout)
    expect(out.removed).toEqual([
      path.join(dir, "skills", "cancel", "SKILL.md"),
    ])
    expect(out.missing).toEqual(["cancel"])
    expect(result.stderr).toContain("/<plugin>:cancel")
    expect(fs.existsSync(path.join(dir, "skills", "cancel"))).toBe(false)
  })

  it("counts an own command file as the front end's version", () => {
    const dir = frontEnd({ "commands/ready.md": "our ready\n" })
    const plan = planFrontEnd(templates, {
      plugin: "team-dev",
      marketplace: "team",
      dir,
      exclude: ["ready"],
    })
    expect(plan.own).toEqual(["ready"])
    expect(plan.missing).toEqual([])
  })

  it("removes a wrapper for a flow the base no longer has", () => {
    const dir = frontEnd({
      "skills/gone/SKILL.md": "<!-- Generated: sends /team-dev:gone -->\n",
      "skills/mine/SKILL.md": "not a wrapper\n",
    })
    const plan = planFrontEnd(templates, {
      plugin: "team-dev",
      marketplace: "team",
      dir,
      exclude: [],
    })
    expect(plan.remove).toEqual([path.join(dir, "skills", "gone", "SKILL.md")])
  })

  it("rejects bad names and unknown flows", () => {
    const args = { plugin: "Team Dev", marketplace: "team", dir: "/x" }
    expect(() => planFrontEnd(templates, { ...args, exclude: [] })).toThrow(
      UsageError,
    )
    expect(() =>
      planFrontEnd(templates, {
        ...args,
        plugin: "team-dev",
        exclude: ["nope"],
      }),
    ).toThrow(/no base flow: nope/)
  })

  it("check exits 1 until the wrappers are written", () => {
    const dir = frontEnd()
    const check = () =>
      spawnSync(
        "node",
        [
          script,
          "check",
          "--plugin",
          "team-dev",
          "--marketplace",
          "team",
          "--dir",
          dir,
        ],
        { encoding: "utf8" },
      )
    expect(check().status).toBe(1)
    write(dir)
    expect(check().status).toBe(0)
  })
})

describe("the Amp front end", () => {
  it("registers every skill it ships, and nothing else", async () => {
    const pluginDir = path.resolve(
      packageDir,
      "..",
      "..",
      "plugins",
      "dev-flows-amp",
    )
    const plugin = await import(path.join(pluginDir, "index.js"))
    const registered: string[] = []
    const logs: string[] = []
    await plugin.default({
      registerSkill: async ({ path: skill }: { path: string }) => {
        registered.push(skill)
      },
      logger: { log: (line: string) => logs.push(line) },
    })
    const folders = fs.readdirSync(path.join(pluginDir, "skills")).sort()
    expect(registered).toEqual(folders.map((name) => `skills/${name}`))
    expect(folders).toEqual([...templates.keys()])
    expect(logs).toEqual([`dev-flows loaded: ${folders.length} skills`])
  })
})

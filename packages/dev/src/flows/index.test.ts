import { describe, expect, it } from "vitest"
import { knownPaths } from "../commands/configure.ts"
import { findCapability } from "../config/integrations.ts"
import { configureFlow } from "./configure.ts"
import { renderAllSkills } from "./index.ts"
import { devKit } from "./kit.ts"

describe("dev flows", () => {
  const files = renderAllSkills()

  it("renders each flow's Claude Code skills", () => {
    expect(files.map((f) => f.path)).toEqual([
      "skills/configure/SKILL.md",
      "skills/evaluate/SKILL.md",
      "skills/evaluate-run/SKILL.md",
    ])
  })

  it("runs commands from the installed plugin root", () => {
    for (const file of files.filter((f) => f.content.includes("node "))) {
      expect(file.content).toContain(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable in rendered markdown
        'node "${CLAUDE_PLUGIN_ROOT}/src/commands/',
      )
    }
  })

  it("only reads config paths that exist", () => {
    const known = knownPaths()
    const reads = files.flatMap((f) =>
      [...f.content.matchAll(/configure\.ts" get ((?:[\w.]+ ?)+)/g)].flatMap(
        (m) => m[1].trim().split(" "),
      ),
    )
    expect(reads).toContain("repo.baseBranch")
    for (const path of reads) {
      expect(known.has(path), path).toBe(true)
    }
  })

  it("only asks for capabilities that exist, never a vendor", () => {
    const asks = files.flatMap((f) =>
      [
        ...f.content.matchAll(/configure\.ts" integrations ((?:\w+ ?)+)/g),
      ].flatMap((m) => m[1].trim().split(" ")),
    )
    expect(asks).toContain("sourceControl")
    for (const id of asks) {
      expect(findCapability(id), id).toBeDefined()
    }
    const evaluate = files.filter((f) => f.path.includes("evaluate"))
    for (const file of evaluate) {
      expect(file.content).not.toMatch(/\bgh |\bglab |GitHub|GitLab/)
    }
  })

  it("routes configure through confirm before writing", () => {
    expect(devKit.describeFlow(configureFlow)).toMatchInlineSnapshot(`
      "Flow: configure ({{cmd}}configure)
      Default mode: default
      Entries:
        default → configure/detect

      Phase: configure
        configure/detect [branch]
          default → <end>, <end>, configure/fill, configure/fill
        configure/fill [action]
          default → configure/confirm
        configure/confirm [branch]
          default → configure/write, configure/fill, <end>
        configure/write [action]
          default → configure/report
        configure/report [action]
          default → <end>"
    `)
  })
})

import { describe, expect, it } from "vitest"
import { Flow } from "./__fixtures__/kit.js"
import { renderMermaid } from "./mermaid.js"

/**
 * Two-mode flow that diverges after a shared entry step: `all` continues to
 * a second step, `lite` terminates immediately. Used to exercise the
 * mode-filter argument to `renderMermaid`.
 */
function twoModeFlow(): Flow {
  return Flow.parse({
    schemaVersion: 1,
    id: "test",
    title: "Test",
    frontmatter: { description: "Desc" },
    entries: { all: "main/start", lite: "main/start" },
    defaultMode: "all",
    phases: [
      {
        id: "main",
        title: "Main",
        steps: [
          {
            id: "start",
            kind: "action",
            title: "Start",
            body: "x",
            next: { byMode: { all: "main/finish", lite: null } },
          },
          {
            id: "finish",
            kind: "action",
            title: "Finish",
            body: "y",
            next: null,
          },
        ],
      },
    ],
  })
}

describe("renderMermaid: mode filtering", () => {
  it("includes every mode's entry marker when no mode is given", () => {
    const out = renderMermaid(twoModeFlow())
    expect(out).toContain("start_all")
    expect(out).toContain("start_lite")
    // byMode edges are labeled with the mode name in the unfiltered diagram
    expect(out).toContain('|"all"|')
  })

  it("shows only the filtered mode's entry marker", () => {
    const out = renderMermaid(twoModeFlow(), { mode: "lite" })
    expect(out).toContain("start_lite")
    expect(out).not.toContain("start_all")
  })

  it("drops steps unreachable in the filtered mode", () => {
    const all = renderMermaid(twoModeFlow(), { mode: "all" })
    const lite = renderMermaid(twoModeFlow(), { mode: "lite" })
    // `finish` is reachable only in `all` mode (lite terminates at start)
    expect(all).toContain("main_finish")
    expect(lite).not.toContain("main_finish")
  })

  it("drops per-mode edge labels when filtered to a single mode", () => {
    const lite = renderMermaid(twoModeFlow(), { mode: "lite" })
    // No mode-name edge labels in a single-mode diagram
    expect(lite).not.toContain('|"all"|')
    expect(lite).not.toContain('|"lite"|')
  })
})

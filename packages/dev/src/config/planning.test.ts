import { describe, expect, it } from "vitest"
import {
  planningLine,
  planningTitle,
  renderSection,
  sourceKey,
  upsertPlanningLine,
  upsertSection,
} from "./planning.ts"

const NOTES = "# Week\n\n- Ship login\n- Fix sync"

describe("planning document", () => {
  it("keys notes by their page, or by their text however it's spaced", () => {
    expect(sourceKey({ url: "https://n/page" }, NOTES)).toBe("https://n/page")
    const key = sourceKey({}, NOTES)
    expect(key).toMatch(/^notes-[0-9a-f]{10}$/)
    expect(sourceKey({}, `  ${NOTES.replaceAll("\n", "\n\n")} `)).toBe(key)
  })

  it("titles the document by the week its cycle starts", () => {
    expect(planningTitle("2026-10-19T07:00:00Z", "2026-10-24")).toBe(
      "Planning, week of 2026-10-19",
    )
    expect(planningTitle(undefined, "2026-10-24")).toBe(
      "Planning, week of 2026-10-24",
    )
  })

  it("writes a section with the notes under its own headings, and its issues", () => {
    expect(
      renderSection("2026-10-24", { title: "Sync" }, "notes-1", NOTES, [
        {
          id: "ENG-1",
          title: "Ship login",
          url: "https://t/1",
          action: "filed",
        },
      ]),
    ).toBe(
      [
        "## 2026-10-24: Sync",
        "Source: pasted notes (notes-1)",
        "### Notes",
        "#### Week\n\n- Ship login\n- Fix sync",
        "### Issues",
        "- [ENG-1](https://t/1): Ship login (filed)",
      ].join("\n\n"),
    )
  })

  it("replaces the section from the same notes and adds others at the end", () => {
    const first = renderSection("2026-10-24", {}, "notes-1", "a", [])
    const other = renderSection("2026-10-24", {}, "notes-2", "b", [])
    const doc = upsertSection(
      upsertSection("Intro", "notes-1", first),
      "notes-2",
      other,
    )
    expect(doc).toBe(`Intro\n\n${first}\n\n${other}\n`)
    const again = renderSection("2026-10-25", {}, "notes-1", "a2", [])
    expect(upsertSection(doc, "notes-1", again)).toBe(
      `Intro\n\n${again}\n\n${other}\n`,
    )
  })

  it("puts one planning line among the link lines on top", () => {
    const line = planningLine(
      "Planning, week of 2026-10-19",
      "https://d",
      { title: "Sync", url: "https://n" },
      "k",
    )
    expect(line).toBe(
      "> Planning: [Planning, week of 2026-10-19](https://d), from [Sync](https://n)",
    )
    const described = "> Branch: `x`\n> Planning: old\n\n## Description\n\nWork"
    expect(upsertPlanningLine(described, line)).toBe(
      `> Branch: \`x\`\n${line}\n\n## Description\n\nWork\n`,
    )
    expect(upsertPlanningLine("Work", line)).toBe(`${line}\n\nWork\n`)
  })
})

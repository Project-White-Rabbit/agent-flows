import { describe, expect, it } from "vitest"
import {
  addBranchLine,
  branchFromDescription,
  hasBranchLine,
  normalizeBranch,
  withoutLinkLines,
} from "./branch-line.ts"

describe("branch lines", () => {
  it("reads the branch however a > Branch: line was written", () => {
    expect(branchFromDescription("> Branch: `sam/eng-12-x`\n\nBody")).toBe(
      "sam/eng-12-x",
    )
    expect(branchFromDescription("Body\n> Branch: sam/eng-12-x")).toBe(
      "sam/eng-12-x",
    )
    expect(
      branchFromDescription("> Branch: sam/[ENG-12](https://t/ENG-12)-x"),
    ).toBe("sam/eng-12-x")
    expect(branchFromDescription("> Branch: not a branch")).toBeUndefined()
    expect(branchFromDescription(null)).toBeUndefined()
  })

  it("adds the line on top of the link lines, once", () => {
    const description = "> Errors: WEB-4P\n\nThe work."
    const added = addBranchLine(description, "sam/eng-12-x")
    expect(added).toBe(
      "> Branch: `sam/eng-12-x`\n> Errors: WEB-4P\n\nThe work.\n",
    )
    expect(addBranchLine(added, "other")).toBe(added)
    expect(addBranchLine("", "b")).toBe("> Branch: `b`\n")
  })

  it("matches whole branch names only", () => {
    expect(hasBranchLine("a\n> Branch: `x`\nb", "x")).toBe(true)
    expect(hasBranchLine("> Branch: x", "x")).toBe(true)
    expect(hasBranchLine("> Branch: `x-y`", "x")).toBe(false)
    expect(hasBranchLine("> Branch: x y", "x")).toBe(false)
    expect(
      hasBranchLine(
        '> Branch: ruven/<issue id="1">ENG-12</issue>-feature',
        "ruven/eng-12-feature",
      ),
    ).toBe(true)
    expect(normalizeBranch("`a/ENG-1-b`")).toBe("a/eng-1-b")
  })

  it("drops the link lines from a description", () => {
    expect(withoutLinkLines("> Branch: `b`\n> Errors: X\n\nBody")).toBe("Body")
  })
})

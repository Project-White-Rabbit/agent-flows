import { describe, expect, it } from "vitest"
import type { DetectContext } from "../../config/types.ts"
import { detectFigma, FIGMA_URL } from "./spec.ts"

function checkout(files: Record<string, string>): DetectContext {
  return {
    root: "/repo",
    git: () => undefined,
    gitCommonDir: undefined,
    tracked: Object.keys(files),
    read: (file) => files[file],
    readJson: () => undefined,
    packageDirs: [""],
    dependsOn: () => [],
    env: {},
    envTemplates: [],
  } as DetectContext
}

describe("detectFigma", () => {
  it("proposes the design file the repo links most, without its node", () => {
    const found = detectFigma(
      checkout({
        "README.md":
          "Designs: https://www.figma.com/design/AbC123/Product?node-id=1-2 and https://www.figma.com/design/AbC123/Product",
        "docs/DESIGN.md": "Old: https://www.figma.com/file/Old999/Legacy",
      }),
    )
    expect(found?.values).toEqual({
      file: "https://www.figma.com/design/AbC123/Product",
    })
    expect(found?.evidence).toEqual([
      "the repo links the Figma file https://www.figma.com/design/AbC123/Product",
    ])
  })

  it("counts Code Connect files as evidence, with or without a link", () => {
    const found = detectFigma(
      checkout({
        "src/Button.figma.tsx":
          'figma.connect(Button, "https://www.figma.com/design/Lib42/Library?node-id=3-4")',
      }),
    )
    expect(found?.values).toEqual({
      file: "https://www.figma.com/design/Lib42/Library",
    })
    expect(found?.evidence[0]).toContain("1 Figma Code Connect file(s)")
    expect(
      detectFigma(checkout({ "figma.config.json": "{}" }))?.values,
    ).toEqual({})
  })

  it("finds nothing in a repo that never mentions Figma", () => {
    expect(detectFigma(checkout({ "README.md": "# app" }))).toBeUndefined()
  })

  it("takes a file URL, a branch, and a node, but not another site", () => {
    for (const url of [
      "https://www.figma.com/design/AbC123/Product",
      "https://figma.com/design/AbC123/branch/Br456/Product?node-id=1-2",
    ]) {
      expect(FIGMA_URL.regex.test(url), url).toBe(true)
    }
    expect(FIGMA_URL.regex.test("https://example.com/design/x")).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import { versionProblem } from "./check-version.ts"

describe("versionProblem", () => {
  it("requires a bump when shipped files change", () => {
    expect(
      versionProblem(["src/flows/evaluate.ts"], "0.1.0", "0.1.0"),
    ).toContain("bump it past 0.1.0")
    expect(
      versionProblem(["src/flows/evaluate.ts"], "0.1.0", "0.0.9"),
    ).toContain("bump it past 0.1.0")
    expect(
      versionProblem(["src/flows/evaluate.ts"], "0.9.0", "0.10.0"),
    ).toBeUndefined()
  })

  it("needs no bump for test-only changes or a brand-new plugin", () => {
    expect(
      versionProblem(["src/flows/index.test.ts"], "0.1.0", "0.1.0"),
    ).toBeUndefined()
    expect(versionProblem(["src/flows/kit.ts"], undefined, "0.1.0")).toBe(
      undefined,
    )
  })

  it("rejects versions Claude Code can't compare", () => {
    expect(versionProblem([], "0.1.0", "0.2")).toContain("must be X.Y.Z")
  })
})

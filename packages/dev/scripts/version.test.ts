import { describe, expect, it } from "vitest"
import { latest, nextVersion, versionProblem } from "./version.ts"

describe("nextVersion", () => {
  it("bumps one level and resets the ones below", () => {
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4")
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0")
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0")
  })
})

describe("latest", () => {
  it("compares numerically and ignores missing or malformed versions", () => {
    expect(latest(["0.9.0", undefined, "0.10.0", "x", "0.2.0"])).toBe("0.10.0")
    expect(latest([undefined])).toBeUndefined()
  })
})

describe("versionProblem", () => {
  const changed = ["src/flows/evaluate.ts"]

  it("requires a version past the base branch's when shipped files change", () => {
    expect(
      versionProblem({ changed, head: "0.1.0", base: "0.1.0", released: [] }),
    ).toContain("not past 0.1.0")
    expect(
      versionProblem({ changed, head: "0.10.0", base: "0.9.0", released: [] }),
    ).toBeUndefined()
  })

  it("rejects a version another PR already took and released", () => {
    // Both PRs bumped 0.1.0 -> 0.1.1; the other merged first.
    expect(
      versionProblem({
        changed,
        head: "0.1.1",
        base: "0.1.1",
        released: ["0.1.0", "0.1.1"],
      }),
    ).toContain("0.1.1 is already released")
  })

  it("needs no bump for test-only changes or a brand-new plugin", () => {
    expect(
      versionProblem({
        changed: ["src/flows/index.test.ts"],
        head: "0.1.0",
        base: "0.1.0",
        released: ["0.1.0"],
      }),
    ).toBeUndefined()
    expect(
      versionProblem({ changed, head: "0.1.0", base: undefined, released: [] }),
    ).toBeUndefined()
  })

  it("rejects versions Claude Code can't compare", () => {
    expect(
      versionProblem({ changed: [], head: "0.2", base: "0.1.0", released: [] }),
    ).toContain("must be X.Y.Z")
  })
})

import { describe, expect, it } from "vitest"
import { downstackOf } from "./graphite.ts"

// main ← a ← b ← c, with d also on a and e on c; x stands alone on main.
const PARENTS = new Map([
  ["a", "main"],
  ["b", "a"],
  ["c", "b"],
  ["d", "a"],
  ["e", "c"],
  ["x", "main"],
])

describe("downstackOf", () => {
  it("reads the chain bottom first, trunk left out", () => {
    expect(downstackOf("c", "main", PARENTS)).toEqual({
      chain: ["a", "b", "c"],
      above: 1,
      size: 5,
    })
  })

  it("counts every branch above, not only the next one", () => {
    expect(downstackOf("a", "main", PARENTS)).toEqual({
      chain: ["a"],
      above: 4,
      size: 5,
    })
  })

  it("makes an untracked branch a chain of one", () => {
    expect(downstackOf("y", "main", PARENTS)).toEqual({
      chain: ["y"],
      above: 0,
      size: 1,
    })
    expect(downstackOf("x", "main", PARENTS)).toEqual({
      chain: ["x"],
      above: 0,
      size: 1,
    })
  })

  it("stops at a cycle in the records", () => {
    const cycle = new Map([
      ["p", "q"],
      ["q", "p"],
    ])
    expect(downstackOf("p", "main", cycle).chain).toEqual(["q", "p"])
  })
})

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  checkSource,
  describeSource,
  readToken,
  sourceReady,
  tokenExpression,
} from "./local.ts"

describe("token sources", () => {
  it("reads a token from a variable, a file, or a command", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-token-"))
    try {
      const file = path.join(dir, "key")
      fs.writeFileSync(file, "from-file\n")
      expect(readToken({ env: "K" }, { K: "from-env" })).toBe("from-env")
      expect(readToken({ file }, {})).toBe("from-file")
      expect(readToken({ command: "printf from-command" }, {})).toBe(
        "from-command",
      )
      expect(readToken({ file: path.join(dir, "absent") }, {})).toBeUndefined()
      expect(readToken({ command: "exit 1" }, {})).toBeUndefined()
      expect(sourceReady({ file }, {})).toBe(true)
      expect(sourceReady({ env: "K" }, {})).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("splices the token in as a shell expression, and describes it without its value", () => {
    expect(tokenExpression({ env: "LINEAR_API_KEY" })).toBe("$LINEAR_API_KEY")
    expect(tokenExpression({ file: "/home/me/.linear" })).toBe(
      "$(cat '/home/me/.linear')",
    )
    expect(tokenExpression({ command: "op read op://dev/linear/key" })).toBe(
      "$(op read op://dev/linear/key)",
    )
    expect(describeSource({ file: "/home/me/.linear" })).toBe(
      "file /home/me/.linear",
    )
  })

  it("refuses sources that would break the expression", () => {
    expect(checkSource({ env: "NOT A NAME" })).toHaveLength(1)
    expect(checkSource({ file: "relative/key" })).toHaveLength(1)
    expect(checkSource({ file: "/tmp/it's" })).toHaveLength(1)
    expect(checkSource({ command: "  " })).toHaveLength(1)
    expect(checkSource({ file: "/home/me/.linear" })).toEqual([])
  })
})

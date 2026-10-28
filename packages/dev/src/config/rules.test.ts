import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { instructionFiles } from "../commands/ready.ts"
import { expandBraces, matchingRules, ruleScope } from "./rules.ts"

describe("rule files", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function repo(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rules-"))
    dirs.push(root)
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), text)
    }
    return root
  }

  it("expands brace alternatives", () => {
    expect(expandBraces("src/**/*.{ts,tsx}")).toEqual([
      "src/**/*.ts",
      "src/**/*.tsx",
    ])
  })

  it("reads Claude's paths and Cursor's globs and alwaysApply", () => {
    expect(
      ruleScope('---\npaths:\n  - "api/**"\n  - web/*.ts\n---\nRule', false),
    ).toEqual({
      globs: ["api/**", "web/*.ts"],
      always: false,
    })
    expect(ruleScope("No frontmatter", false)).toEqual({
      globs: [],
      always: true,
    })
    expect(ruleScope("---\nglobs: *.sql, db/**\n---", true)).toEqual({
      globs: ["*.sql", "db/**"],
      always: false,
    })
    expect(ruleScope("---\nalwaysApply: true\n---", true)).toEqual({
      globs: [],
      always: true,
    })
    expect(ruleScope('---\npaths: ["a/**", b/*]\n---', false).globs).toEqual([
      "a/**",
      "b/*",
    ])
  })

  it("lists the rules whose globs match a changed file, from any directory's rules", () => {
    const root = repo({
      "AGENTS.md": "root",
      ".claude/rules/api.md": '---\npaths:\n  - "api/**/*.{ts,sql}"\n---\n',
      ".claude/rules/web.md": "---\npaths: web/**\n---\n",
      ".claude/rules/general.md": "Always",
      ".cursor/rules/sql.mdc": "---\nglobs: *.sql\n---\n",
      ".cursor/rules/manual.mdc": "---\ndescription: on request\n---\n",
      "pkg/.claude/rules/local.md": "---\npaths: src/**\n---\n",
    })
    const changed = ["api/v1/q.sql", "pkg/src/a.ts"]
    expect(matchingRules(root, [".", "pkg"], changed)).toEqual([
      ".claude/rules/api.md",
      ".claude/rules/general.md",
      ".cursor/rules/sql.mdc",
      "pkg/.claude/rules/local.md",
    ])
    expect(instructionFiles(root, ["api/v1/q.sql"])).toEqual([
      "AGENTS.md",
      ".claude/rules/api.md",
      ".claude/rules/general.md",
      ".cursor/rules/sql.mdc",
    ])
  })
})

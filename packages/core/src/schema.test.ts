import { describe, expect, it } from "vitest"
import { Flow } from "./__fixtures__/kit.js"
import { collectCalledCommandIds } from "./schema.js"

/**
 * Minimal valid flow used as the base for schema-validation tests. Each test
 * spreads a partial override on top to exercise one contract at a time.
 */
function baseFlow(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "test",
    title: "Test Flow",
    frontmatter: { description: "Test" },
    entries: { all: "main/start" },
    phases: [
      {
        id: "main",
        title: "Main",
        steps: [
          {
            id: "start",
            kind: "action",
            title: "Start",
            body: "Body",
            next: null,
          },
        ],
      },
    ],
  }
}

describe("Schema: structural validation", () => {
  it("accepts a minimal valid flow", () => {
    expect(() => Flow.parse(baseFlow())).not.toThrow()
  })

  it("rejects a flow whose entry points to a nonexistent step", () => {
    const flow = baseFlow()
    flow.entries = { all: "main/does-not-exist" }
    expect(() => Flow.parse(flow)).toThrow(/unknown step/)
  })

  it("rejects an action step with a dangling next reference", () => {
    const flow = baseFlow()
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "action",
        title: "Start",
        body: "x",
        next: "main/missing",
      },
    ]
    expect(() => Flow.parse(flow)).toThrow(/unknown step/)
  })

  it("rejects a misspelled key on a branch instead of silently dropping it", () => {
    // `description` misspelled as `action` used to survive parse (zod strips
    // unknown keys) and typecheck (Flow.parse takes an untyped literal), so the
    // branch rendered as a bare "continue" with no way to notice.
    const flow = baseFlow()
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "branch",
        title: "Start",
        body: "x {{whens}}",
        branches: [
          { when: "a", action: "skip ahead", next: null },
          { when: "b", next: null },
        ],
      },
    ]
    expect(() => Flow.parse(flow)).toThrow(/action/)
  })

  it("rejects duplicate step ids within a phase", () => {
    const flow = baseFlow()
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "action",
        title: "A",
        body: "x",
        next: "main/start",
      },
      { id: "start", kind: "action", title: "B", body: "y", next: null },
    ]
    expect(() => Flow.parse(flow)).toThrow(/duplicate step id/)
  })

  it("rejects unreachable steps", () => {
    const flow = baseFlow()
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      { id: "start", kind: "action", title: "Start", body: "x", next: null },
      { id: "orphan", kind: "action", title: "Orphan", body: "y", next: null },
    ]
    expect(() => Flow.parse(flow)).toThrow(/unreachable/)
  })

  it("rejects defaultMode not declared in entries", () => {
    const flow = baseFlow()
    flow.defaultMode = "ghost"
    expect(() => Flow.parse(flow)).toThrow(/defaultMode/)
  })

  it("rejects modeHints key not declared in entries", () => {
    const flow = baseFlow()
    flow.modeHints = { ghost: "no such mode" }
    expect(() => Flow.parse(flow)).toThrow(/modeHints key/)
  })

  it("rejects a derived argument hint without a non-default mode", () => {
    const flow = baseFlow()
    flow.entries = { default: "main/start" }
    flow.defaultMode = "default"
    flow.frontmatter = {
      description: "Test",
      argumentHint: { deriveFromModes: true },
    }
    expect(() => Flow.parse(flow)).toThrow(/non-default mode/)
  })

  it("rejects next.byMode with mode not in entries", () => {
    const flow = baseFlow()
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "action",
        title: "Start",
        body: "x",
        next: { byMode: { all: null, ghost: null } },
      },
    ]
    expect(() => Flow.parse(flow)).toThrow(/not declared in flow.entries/)
  })

  it("rejects step.toolCalls referring to undeclared tool id", () => {
    const flow = baseFlow()
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "action",
        title: "Start",
        body: "x",
        toolCalls: ["ghost"],
        next: null,
      },
    ]
    expect(() => Flow.parse(flow)).toThrow(/not declared in flow.tools/)
  })

  it("rejects step.commandCalls referring to undeclared command id", () => {
    const flow = baseFlow()
    flow.commands = {
      status: { file: "status.js", description: "Check status" },
    }
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "action",
        title: "Start",
        body: "x",
        commandCalls: ["ghost"],
        next: null,
      },
    ]
    expect(() => Flow.parse(flow)).toThrow(/not declared in flow.commands/)
  })

  it("accepts step.commandCalls referencing declared commands", () => {
    const flow = baseFlow()
    flow.commands = {
      status: { file: "status.js", description: "Check status" },
    }
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "action",
        title: "Start",
        body: "Run {{command:status}}.",
        commandCalls: ["status"],
        next: null,
      },
    ]
    expect(() => Flow.parse(flow)).not.toThrow()
  })

  it("accepts a flow with declared commands", () => {
    const flow = baseFlow()
    flow.commands = {
      status: { file: "status.js", description: "Check status" },
    }
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "action",
        title: "Start",
        body: "Run {{command:status}}.",
        next: null,
      },
    ]
    expect(() => Flow.parse(flow)).not.toThrow()
  })

  it("rejects {{command:id}} referencing undeclared command", () => {
    const flow = baseFlow()
    flow.commands = {
      status: { file: "status.js", description: "Check status" },
    }
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "action",
        title: "Start",
        body: "Run {{command:ghost}}.",
        next: null,
      },
    ]
    expect(() => Flow.parse(flow)).toThrow(
      /\{\{command:ghost\}\}.*not declared in flow\.commands/,
    )
  })

  it("rejects flow.variables names that collide with reserved target tokens", () => {
    const flow = baseFlow()
    flow.variables = { cmd: "should-collide" }
    expect(() => Flow.parse(flow)).toThrow(/collides with the target token/)
  })

  it("rejects branch entries with neither `when` nor `option`", () => {
    const flow = baseFlow()
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "branch",
        title: "Start",
        body: "x",
        branches: [
          { next: null }, // no when, no option
          { when: "ok", next: null },
        ],
      },
    ]
    expect(() => Flow.parse(flow)).toThrow(/`when` or `option`/)
  })

  it("rejects next.byMode that omits a declared mode", () => {
    const flow = baseFlow()
    flow.entries = { all: "main/start", lite: "main/start" }
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "action",
        title: "Start",
        body: "x",
        next: { byMode: { all: null } }, // missing `lite`
      },
    ]
    expect(() => Flow.parse(flow)).toThrow(/missing entries for mode/)
  })

  it("rejects a phase with more than one preamble step", () => {
    const flow = baseFlow()
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "p1",
        kind: "action",
        title: "P1",
        body: "x",
        preamble: true,
        next: "main/p2",
      },
      {
        id: "p2",
        kind: "action",
        title: "P2",
        body: "y",
        preamble: true,
        next: "main/start",
      },
      { id: "start", kind: "action", title: "Start", body: "z", next: null },
    ]
    flow.entries = { all: "main/start" }
    expect(() => Flow.parse(flow)).toThrow(
      /preamble steps; only one is allowed/,
    )
  })

  it("rejects reference steps pointing to undeclared appendix", () => {
    const flow = baseFlow()
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "start",
        kind: "reference",
        title: "Start",
        body: "x",
        refs: ["ghost"],
        next: null,
      },
    ]
    expect(() => Flow.parse(flow)).toThrow(/unknown appendix/)
  })
})

describe("Schema: Targetable validation", () => {
  it("accepts a per-target object with `default`", () => {
    const flow = baseFlow()
    flow.frontmatter = {
      description: { default: "shared", codex: "codex-only" },
    }
    expect(() => Flow.parse(flow)).not.toThrow()
  })

  it("accepts a per-target object that lists every target explicitly", () => {
    const flow = baseFlow()
    flow.frontmatter = {
      description: { claude: "C", cursor: "Cu", codex: "Cx", amp: "A" },
    }
    expect(() => Flow.parse(flow)).not.toThrow()
  })

  it("rejects a per-target object missing both default and exhaustive coverage", () => {
    const flow = baseFlow()
    flow.frontmatter = { description: { codex: "only codex" } }
    expect(() => Flow.parse(flow)).toThrow(
      /default.*exhaustive|exhaustive|all of claude/i,
    )
  })
})

describe("Schema: per-target entries", () => {
  it("accepts entries that route different targets to different steps", () => {
    const flow = baseFlow()
    ;(flow.phases as Array<{ steps: unknown[] }>)[0].steps = [
      {
        id: "preamble",
        kind: "action",
        title: "Preamble",
        body: "p",
        preamble: true,
        next: "main/start",
      },
      { id: "start", kind: "action", title: "Start", body: "x", next: null },
    ]
    flow.entries = {
      all: { default: "main/start", codex: "main/preamble" },
    }
    expect(() => Flow.parse(flow)).not.toThrow()
  })

  it("rejects per-target entries that omit a target without a default", () => {
    const flow = baseFlow()
    flow.entries = {
      all: { codex: "main/start" }, // no default, no claude/cursor
    }
    expect(() => Flow.parse(flow)).toThrow()
  })
})

describe("collectCalledCommandIds", () => {
  it("returns command ids referenced by step.commandCalls in registry order", () => {
    const flow = Flow.parse({
      schemaVersion: 1,
      id: "test",
      title: "Test",
      frontmatter: { description: "Test" },
      entries: { all: "main/a" },
      commands: {
        alpha: { file: "alpha.js", description: "A" },
        beta: { file: "beta.js", description: "B" },
        gamma: { file: "gamma.js", description: "C" },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "x",
              commandCalls: ["beta", "alpha"],
              next: null,
            },
          ],
        },
      ],
    })
    expect(collectCalledCommandIds(flow)).toEqual(["alpha", "beta"])
  })

  it("excludes unreferenced commands", () => {
    const flow = Flow.parse({
      schemaVersion: 1,
      id: "test",
      title: "Test",
      frontmatter: { description: "Test" },
      entries: { all: "main/a" },
      commands: {
        used: { file: "used.js", description: "Used" },
        unused: { file: "unused.js", description: "Unused" },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "{{command:used}}",
              commandCalls: ["used"],
              next: null,
            },
          ],
        },
      ],
    })
    expect(collectCalledCommandIds(flow)).toEqual(["used"])
  })
})

describe("Schema: compile mode", () => {
  it("defaults compile to monolith with no inline phases", () => {
    const flow = Flow.parse(baseFlow())
    expect(flow.compile.mode).toBe("monolith")
    expect(flow.compile.inlinePhases).toEqual([])
  })

  it("accepts a per-target mode that splits one target only", () => {
    const flow = baseFlow()
    flow.compile = { mode: { default: "monolith", claude: "split" } }
    expect(() => Flow.parse(flow)).not.toThrow()
  })

  it("accepts split mode with inlinePhases referencing real phases", () => {
    const flow = baseFlow()
    flow.compile = { mode: "split", inlinePhases: ["main"] }
    expect(() => Flow.parse(flow)).not.toThrow()
  })

  it("rejects inlinePhases referencing an unknown phase", () => {
    const flow = baseFlow()
    flow.compile = { mode: "split", inlinePhases: ["does-not-exist"] }
    expect(() => Flow.parse(flow)).toThrow(/unknown phase/)
  })
})

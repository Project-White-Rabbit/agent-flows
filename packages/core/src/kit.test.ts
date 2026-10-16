import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createFlowKit, resolveOutputPath } from "./kit.js"
import type { FlowInput } from "./schema.js"
import { claudeCode, codex, namedFrontmatter } from "./targets.js"
import { writeGeneratedFiles } from "./write.js"

/** A host that is not one of the presets: plain markdown "prompts". */
const promptHost = {
  tokens: { cmd: "run ", editor: "Prompt Runner" },
  mcpPrefix: "",
  argsToken: "the input",
  frontmatter: ({
    flowId,
    description,
  }: {
    flowId: string
    description: string
  }) => namedFrontmatter(flowId, description, ""),
  subSkillFrontmatter: ({
    flowId,
    description,
  }: {
    flowId: string
    description: string
  }) => namedFrontmatter(flowId, description, ""),
}

const kit = createFlowKit({
  targets: {
    claude: claudeCode({ plugin: "acme", mcpServer: "Acme" }),
    prompts: promptHost,
  },
  sections: { "rich-ui": ["claude"] },
})

function flowInput(overrides: Partial<FlowInput> = {}): FlowInput {
  return {
    schemaVersion: 1,
    id: "greet",
    title: "Greet",
    frontmatter: { description: "Say hello" },
    entries: { default: "main/hello" },
    tools: {
      lookup: { name: "lookup_user", kind: "mcp" },
    },
    phases: [
      {
        id: "main",
        title: "Main",
        stepStyle: "headers",
        steps: [
          {
            id: "hello",
            kind: "action",
            title: "Hello",
            body: {
              default:
                "Greet the user from {{editor}}.{{#rich-ui}} Use a card.{{/rich-ui}}",
              claude:
                "Call {{tool:lookup}}, then greet the user from {{editor}}.{{#rich-ui}} Use a card.{{/rich-ui}}",
            },
            next: null,
          },
        ],
      },
    ],
    ...overrides,
  }
}

describe("createFlowKit", () => {
  it("renders one flow for a preset and a custom host", () => {
    const flow = kit.defineFlow(flowInput())
    const [claude] = kit.render(flow, "claude")
    const [prompts] = kit.render(flow, "prompts")
    expect(claude?.content).toContain(
      "Call `mcp__plugin_acme_Acme__lookup_user`, then greet the user from Claude Code. Use a card.",
    )
    expect(claude?.content).toContain(
      'allowed-tools: ["mcp__plugin_acme_Acme__lookup_user"]',
    )
    expect(prompts?.content).toContain("name: greet")
    expect(prompts?.content).toContain("Greet the user from Prompt Runner.")
    expect(prompts?.content).not.toContain("Use a card")
  })

  it("rejects per-target keys that name no configured target", () => {
    expect(() =>
      kit.defineFlow(flowInput({ title: { default: "Greet", cursor: "G" } })),
    ).toThrow(/Unknown target "cursor"/)
  })

  it("requires `default` or every target in a per-target map", () => {
    expect(() =>
      kit.defineFlow(flowInput({ title: { claude: "Greet" } })),
    ).toThrow(/must have `default` or define all of claude\/prompts/)
  })

  it("rejects flow variables that shadow a target token", () => {
    expect(() =>
      kit.defineFlow(flowInput({ variables: { editor: "x" } })),
    ).toThrow(/collides with the target token/)
  })

  it("names the flow in validation errors", () => {
    expect(() =>
      kit.defineFlow(flowInput({ entries: { default: "main/missing" } })),
    ).toThrow(/Invalid flow "greet"/)
  })

  it("validates target and section names", () => {
    expect(() =>
      createFlowKit({ targets: { Claude: claudeCode({ plugin: "a" }) } }),
    ).toThrow(/invalid target name/)
    expect(() =>
      createFlowKit({
        targets: { claude: claudeCode({ plugin: "a" }) },
        sections: { claude: ["claude"] },
      }),
    ).toThrow(/collides with a target name/)
  })

  it("renders commands through the default convention", () => {
    const flow = kit.defineFlow(
      flowInput({
        commands: {
          status: { file: "acme status", description: "Show status" },
        },
        phases: [
          {
            id: "main",
            title: "Main",
            stepStyle: "headers",
            steps: [
              {
                id: "hello",
                kind: "action",
                title: "Hello",
                body: "Run `{{command:status}}`.",
                next: null,
              },
            ],
          },
        ],
      }),
    )
    const out = kit.renderMarkdown(flow, "prompts")
    expect(out).toContain("Run `acme status`.")
    expect(out).toContain("**CLI commands** available via `Bash`:")
    expect(out).toContain("| `acme status` | Show status |")
  })
})

describe("codex preset", () => {
  it("resolves the plugin dir from a marker file", () => {
    const target = codex({
      plugin: "acme",
      pluginDir: { markerFile: "dist/commands/status.js" },
    })
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable
    expect(target.tokens.pluginRoot).toBe("${ACME_PLUGIN_DIR}")
    expect(target.tokens.pluginDirLookup).toContain(
      "-path '*/acme/*/dist/commands/status.js'",
    )
    expect(target.phaseReferences).toBe(true)
  })
})

describe("resolveOutputPath", () => {
  const main = "plugin/skills/greet/SKILL.md"

  it("places the main file at the configured path", () => {
    expect(
      resolveOutputPath(main, { slug: "", kind: "monolith", content: "" }),
    ).toBe(main)
  })

  it("derives sibling skill dirs for phase sub-skills", () => {
    expect(
      resolveOutputPath(main, { slug: "run", kind: "phase", content: "" }),
    ).toBe("plugin/skills/greet-run/SKILL.md")
  })

  it("places phase references next to the main file", () => {
    expect(
      resolveOutputPath(main, { slug: "run", kind: "reference", content: "" }),
    ).toBe("plugin/skills/greet/references/run.md")
  })

  it("honors an explicit phase pattern", () => {
    expect(
      resolveOutputPath(
        { main, phase: "plugin/phases/{phase}.md" },
        { slug: "run", kind: "phase", content: "" },
      ),
    ).toBe("plugin/phases/run.md")
  })
})

describe("renderProject + writeGeneratedFiles", () => {
  it("writes split files, then reports drift in check mode", () => {
    const flow = kit.defineFlow(
      flowInput({
        compile: { mode: "split-chain", inlinePhases: ["main"] },
        entries: { default: "main/hello" },
        phases: [
          {
            id: "main",
            title: "Main",
            stepStyle: "headers",
            steps: [
              {
                id: "hello",
                kind: "action",
                title: "Hello",
                body: "Say hi.",
                next: "run/work",
              },
            ],
          },
          {
            id: "run",
            title: "Run",
            stepStyle: "headers",
            steps: [
              {
                id: "work",
                kind: "action",
                title: "Work",
                body: "Do it.   ",
                next: null,
              },
            ],
          },
        ],
      }),
    )
    const files = kit.renderProject([
      { flow, outputs: { claude: "claude/skills/greet/SKILL.md" } },
    ])
    expect(files.map((f) => f.path)).toEqual([
      "claude/skills/greet/SKILL.md",
      "claude/skills/greet-run/SKILL.md",
    ])

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-"))
    try {
      expect(writeGeneratedFiles(files, { rootDir }).changed).toHaveLength(2)
      const written = fs.readFileSync(
        path.join(rootDir, "claude/skills/greet-run/SKILL.md"),
        "utf-8",
      )
      expect(written).toContain("Do it.\n")
      expect(writeGeneratedFiles(files, { rootDir, check: true })).toEqual({
        changed: [],
        unchanged: 2,
      })

      fs.writeFileSync(
        path.join(rootDir, "claude/skills/greet/SKILL.md"),
        "stale",
      )
      const drift = writeGeneratedFiles(files, { rootDir, check: true })
      expect(drift.changed).toEqual(["claude/skills/greet/SKILL.md"])
      expect(
        fs.readFileSync(
          path.join(rootDir, "claude/skills/greet/SKILL.md"),
          "utf-8",
        ),
      ).toBe("stale")
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })
})

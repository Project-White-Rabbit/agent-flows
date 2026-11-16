import { describe, expect, it } from "vitest"
import { createFlowKit } from "./kit.js"
import { entryFrontmatterInput } from "./render.js"
import type { FlowInput } from "./schema.js"
import { baseTarget, claudeCode, codex } from "./targets.js"

const claude = claudeCode({ plugin: "acme" })
const kit = createFlowKit({
  targets: {
    claude: baseTarget(claude, {
      rootVar: "ACME_BASE",
      flowsDir: "flows/claude",
      generatedNotice: "<!-- generated -->",
    }),
  },
})

const chainFlow: FlowInput = {
  schemaVersion: 1,
  id: "ship",
  title: "{{cmd}}ship",
  frontmatter: { description: "Ship it", argumentHint: "[fast]" },
  entries: { default: "setup/run", fast: "setup/run" },
  defaultMode: "default",
  modeHints: { default: "Ship slowly.", fast: "Ship fast." },
  compile: { mode: "split-chain", inlinePhases: ["setup"] },
  phases: [
    {
      id: "setup",
      title: "Setup",
      stepStyle: "list",
      steps: [
        {
          id: "run",
          kind: "action",
          title: "Run",
          body: "Run `node {{pluginRoot}}/x.ts`, then run {{flow:sync}} with the argument `local`. Tell the user to run `{{cmd}}configure`.",
          next: { byMode: { default: "push/go", fast: "push/go" } },
        },
      ],
    },
    {
      id: "push",
      title: "Push",
      stepStyle: "list",
      steps: [
        {
          id: "go",
          kind: "action",
          title: "Go",
          body: "Push.",
          next: null,
        },
      ],
    },
  ],
}

describe("baseTarget", () => {
  const flow = kit.defineFlow(chainFlow)
  const files = kit.renderProject([
    { flow, outputs: { claude: "flows/claude/ship/flow.md" } },
  ])
  const main = files.find((f) => f.path === "flows/claude/ship/flow.md")
  const push = files.find(
    (f) => f.path === "flows/claude/ship/references/push.md",
  )

  it("renders a flow file and phase references, no skills", () => {
    expect(files.map((f) => f.path).sort()).toEqual([
      "flows/claude/ship/flow.md",
      "flows/claude/ship/references/push.md",
    ])
    expect(
      main?.content.startsWith("<!-- generated -->\n\n# /<caller>:ship"),
    ).toBe(true)
    expect(main?.content).not.toContain("description:")
    expect(push?.content).not.toContain("user-invocable")
  })

  it("writes commands with the caller's prefix and the root as a variable", () => {
    expect(main?.content).toContain(
      "Tell the user to run `/<caller>:configure`",
    )
    expect(main?.content).toContain("Run `node $ACME_BASE/x.ts`")
    expect(main?.content).toContain("You were sent here by a command")
    expect(push?.content).toContain(
      "This continues the flow you were following",
    )
  })

  it("names another flow by its file, keeping the caller", () => {
    expect(main?.content).toContain(
      "run the sync flow (read `$ACME_BASE/flows/claude/sync/flow.md` and follow it, with the same caller",
    )
  })

  it("names the arguments in plain words and links phases as references", () => {
    expect(main?.content).toContain(
      "read and follow the [Push](references/push.md) reference with the current mode (`default` or `fast`), forwarding the arguments you were given minus the leading mode keyword",
    )
    expect(main?.content).not.toContain("$ARGUMENTS")
  })

  it("leaves skill targets naming another flow as a skill", () => {
    const skills = createFlowKit({ targets: { claude } })
    const [entry] = skills.render(skills.defineFlow(chainFlow), "claude")
    expect(entry?.content).toContain(
      "then run the `/acme:sync` skill with the argument `local`",
    )
  })

  it("gives a front end the entry's frontmatter fields", () => {
    expect(entryFrontmatterInput(flow, kit.targets.claude)).toEqual({
      flowId: "ship",
      description: "Ship it",
      argumentHint: "[fast]",
      model: undefined,
    })
  })

  it("writes another host's caller prefix", () => {
    const codexKit = createFlowKit({
      targets: {
        codex: baseTarget(codex({ plugin: "acme" }), {
          rootVar: "ACME_BASE",
          flowsDir: "flows/codex",
          callerCmd: "$<caller>:",
        }),
      },
    })
    const [entry] = codexKit.renderProject([
      {
        flow: codexKit.defineFlow(chainFlow),
        outputs: { codex: "flows/codex/ship/flow.md" },
      },
    ])
    expect(entry?.content).toContain("# $<caller>:ship")
    expect(entry?.content).toContain(
      "Tell the user to run `$<caller>:configure`",
    )
    expect(entry?.content).toContain("`$<caller>:sync` is `$acme:sync`")
    expect(entry?.content).toContain("$ACME_BASE/flows/codex/sync/flow.md")
  })

  it("refuses a caller prefix without <caller>", () => {
    expect(() =>
      baseTarget(claude, {
        rootVar: "ACME_BASE",
        flowsDir: "flows/claude",
        callerCmd: "/acme:",
      }),
    ).toThrow(/must contain <caller>/)
  })
})

import { describe, expect, it } from "vitest"
import { DEV_TARGETS, Flow, TARGETS } from "./__fixtures__/kit.js"
import { renderFlow, renderMarkdown } from "./render.js"

/**
 * Build a minimal valid Flow with the given overrides applied to the base.
 * Top-level fields override the base; phases/steps replace whole.
 */
function makeFlow(overrides: Record<string, unknown> = {}): Flow {
  return Flow.parse({
    schemaVersion: 1,
    id: "test",
    title: "Test",
    frontmatter: { description: "Desc" },
    entries: { all: "main/a" },
    phases: [
      {
        id: "main",
        title: "Main",
        stepStyle: "headers",
        steps: [
          { id: "a", kind: "action", title: "A", body: "Body A", next: null },
        ],
      },
    ],
    ...overrides,
  })
}

describe("Renderer: argument hints", () => {
  it("derives optional modes and appends a literal suffix", () => {
    const flow = makeFlow({
      frontmatter: {
        description: "Desc",
        argumentHint: {
          deriveFromModes: true,
          suffix: "[target]",
        },
      },
      entries: {
        default: "main/a",
        local: "main/a",
        remote: "main/a",
        help: "main/a",
      },
      defaultMode: "default",
    })

    expect(renderMarkdown(flow, TARGETS.claude)).toContain(
      'argument-hint: "[local|remote|help] [target]"',
    )
    expect(renderMarkdown(flow, DEV_TARGETS.cursor)).toContain(
      "Usage: /acme-dev-test [local|remote|help] [target]",
    )
    expect(renderMarkdown(flow, DEV_TARGETS.codex)).toContain(
      "Invoke with $acme-dev:test [local|remote|help] [target].",
    )
  })

  it.each(["cursor", "codex", "amp"] as const)(
    "keeps %s dev invocation syntax in the body without inflating discovery metadata",
    (editor) => {
      const flow = makeFlow({
        frontmatter: { description: "Desc", argumentHint: "[target]" },
      })
      const [, frontmatter, body] = renderMarkdown(
        flow,
        DEV_TARGETS[editor],
      ).split("---")

      expect(frontmatter).toContain('description: "Desc"')
      expect(frontmatter).not.toContain("[target]")
      expect(body).toContain("[target]")
      expect(body).toContain("Body A")
      expect(renderMarkdown(flow, TARGETS[editor]).split("---")[1]).toContain(
        "[target]",
      )
    },
  )

  it("renders a required mode union when the flow has no default mode", () => {
    const flow = makeFlow({
      frontmatter: {
        description: "Desc",
        argumentHint: { deriveFromModes: true },
      },
      entries: {
        local: "main/a",
        remote: "main/a",
      },
    })

    expect(renderMarkdown(flow, TARGETS.claude)).toContain(
      'argument-hint: "<local|remote>"',
    )
  })

  it("keeps an explicit default token when another mode is the default", () => {
    const flow = makeFlow({
      frontmatter: {
        description: "Desc",
        argumentHint: { deriveFromModes: true },
      },
      entries: {
        default: "main/a",
        local: "main/a",
      },
      defaultMode: "local",
    })

    expect(renderMarkdown(flow, TARGETS.claude)).toContain(
      'argument-hint: "[default|local]"',
    )
  })

  it("preserves literal argument hints", () => {
    const flow = makeFlow({
      frontmatter: {
        description: "Desc",
        argumentHint: "[scope | help]",
      },
    })

    expect(renderMarkdown(flow, TARGETS.claude)).toContain(
      'argument-hint: "[scope | help]"',
    )
  })
})

describe("Renderer: reachability-based visibility", () => {
  it("only renders steps reachable for the current target", () => {
    const flow = makeFlow({
      entries: {
        all: { default: "main/start", codex: "main/preamble" },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "preamble",
              kind: "action",
              title: "Codex Preamble",
              body: "preamble body",
              preamble: true,
              next: "main/start",
            },
            {
              id: "start",
              kind: "action",
              title: "Start",
              body: "start body",
              next: null,
            },
          ],
        },
      ],
    })
    const claudeOut = renderMarkdown(flow, TARGETS.claude)
    const codexOut = renderMarkdown(flow, TARGETS.codex)
    expect(claudeOut).not.toContain("Codex Preamble")
    expect(claudeOut).toContain("## 1. Start")
    expect(codexOut).toContain("## 0. Codex Preamble")
    expect(codexOut).toContain("## 1. Start")
  })

  it("numbers preamble steps as 0, others 1-indexed", () => {
    const flow = makeFlow({
      entries: { all: "main/p" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "p",
              kind: "action",
              title: "P",
              body: "p",
              preamble: true,
              next: "main/a",
            },
            { id: "a", kind: "action", title: "A", body: "a", next: "main/b" },
            { id: "b", kind: "action", title: "B", body: "b", next: null },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("## 0. P")
    expect(out).toContain("## 1. A")
    expect(out).toContain("## 2. B")
  })
})

describe("Renderer: mode-gate prose", () => {
  it("emits per-step 'Run only when mode is X' on steps with mixed reachability", () => {
    const flow = makeFlow({
      entries: { all: "main/a", lite: "main/a" },
      defaultMode: "all",
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "always",
              next: { byMode: { all: "main/b", lite: "main/c" } },
            },
            {
              id: "b",
              kind: "action",
              title: "B",
              body: "all-only",
              next: "main/c",
            },
            {
              id: "c",
              kind: "action",
              title: "C",
              body: "always C",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    // Phase has mixed reachability (a, c reach in both; b reaches only in all),
    // so the gate goes on step b inline, not at the phase level.
    expect(out).toContain("**Run only when mode is `all`.**")
    expect(out).not.toContain("Skip this step")
  })

  it("emits each affected step's gate independently (no inheritance)", () => {
    const flow = makeFlow({
      entries: { all: "main/a", lite: "main/a" },
      defaultMode: "all",
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "A",
              next: { byMode: { all: "main/b", lite: "main/d" } },
            },
            {
              id: "b",
              kind: "action",
              title: "B",
              body: "B",
              next: "main/c",
            },
            {
              id: "c",
              kind: "action",
              title: "C",
              body: "C",
              next: "main/d",
            },
            { id: "d", kind: "action", title: "D", body: "D", next: null },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    // Both step b AND step c are reachable only in `all`. Each gets its own
    // gate; positive-form gates do not cascade or inherit.
    const matches = out.match(/Run only when mode is `all`/g) ?? []
    expect(matches.length).toBe(2)
  })

  it("emits a single phase-level gate when every visible step shares the same reachability", () => {
    const flow = makeFlow({
      entries: { all: "p1/a", lite: "p2/x" },
      defaultMode: "all",
      phases: [
        {
          id: "p1",
          title: "Phase 1",
          stepStyle: "list",
          steps: [
            { id: "a", kind: "action", title: "A", body: "A", next: "p1/b" },
            { id: "b", kind: "action", title: "B", body: "B", next: "p2/x" },
          ],
        },
        {
          id: "p2",
          title: "Phase 2",
          stepStyle: "list",
          steps: [
            { id: "x", kind: "action", title: "X", body: "X", next: null },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    // Phase 1 (steps a, b) is reachable only in `all`; emits ONE phase-level
    // gate before the steps. Phase 2 (step x) is reachable in both modes;
    // emits nothing.
    const matches = out.match(/Run only when mode is `all`/g) ?? []
    expect(matches.length).toBe(1)
    // Phase-level gate appears between the phase title and the first step.
    expect(out).toMatch(
      /## Phase 1\s+\*\*Run only when mode is `all`\.\*\*\s+1\. /,
    )
  })

  it("uses positive form even when many modes are excluded", () => {
    const flow = makeFlow({
      entries: { a: "main/x", b: "main/x", c: "main/x", d: "main/x" },
      defaultMode: "a",
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "x",
              kind: "action",
              title: "X",
              body: "X",
              next: { byMode: { a: "main/y", b: null, c: null, d: null } },
            },
            { id: "y", kind: "action", title: "Y", body: "Y", next: null },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    // Step y is reachable only in mode `a`. Positive form names just the
    // included mode rather than enumerating the three excluded modes.
    expect(out).toContain("**Run only when mode is `a`.**")
    expect(out).not.toContain("Skip this step")
  })
})

describe("Renderer: tool registry and {{tool:id}}", () => {
  it("renders builtin tools as the bare name in backticks", () => {
    const flow = makeFlow({
      tools: { read: { kind: "builtin", name: "Read" } },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "Use {{tool:read}} to verify.",
              toolCalls: ["read"],
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("Use `Read` to verify.")
  })

  it("prepends the target's mcpPrefix for MCP tools", () => {
    const flow = makeFlow({
      tools: { apiKey: { kind: "mcp", name: "get_acme_api_key" } },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "Call {{tool:apiKey}}.",
              toolCalls: ["apiKey"],
              next: null,
            },
          ],
        },
      ],
    })
    const claudeOut = renderMarkdown(flow, TARGETS.claude)
    const codexOut = renderMarkdown(flow, TARGETS.codex)
    expect(claudeOut).toContain("`mcp__plugin_acme_Acme__get_acme_api_key`")
    expect(codexOut).toContain("`mcp__Acme__get_acme_api_key`")
  })

  it("auto-derives allowedTools from union of step toolCalls (registry order)", () => {
    const flow = makeFlow({
      tools: {
        bash: { kind: "builtin", name: "Bash" },
        read: { kind: "builtin", name: "Read" },
        ghost: { kind: "builtin", name: "Ghost" },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "x",
              toolCalls: ["read", "bash"],
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    // Order matches registry, not toolCalls. Ghost is unused → omitted.
    expect(out).toContain('allowed-tools: ["Bash", "Read"]')
    expect(out).not.toContain("Ghost")
  })

  it("renders a fully different tool id per agent via a per-target name", () => {
    const flow = makeFlow({
      tools: {
        cal: {
          kind: "builtin",
          name: {
            claude: "mcp__claude_ai_Google_Calendar__list_events",
            cursor: "mcp__Google_Calendar__list_events",
            codex: "mcp__gcal__list_events",
            amp: "mcp__amp_gcal__list_events",
          },
        },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "Call {{tool:cal}}.",
              toolCalls: ["cal"],
              next: null,
            },
          ],
        },
      ],
    })
    expect(renderMarkdown(flow, TARGETS.claude)).toContain(
      "`mcp__claude_ai_Google_Calendar__list_events`",
    )
    expect(renderMarkdown(flow, TARGETS.cursor)).toContain(
      "`mcp__Google_Calendar__list_events`",
    )
    expect(renderMarkdown(flow, TARGETS.codex)).toContain(
      "`mcp__gcal__list_events`",
    )
  })

  it("omits a Claude-only tool from other agents' allowed-tools", () => {
    const flow = makeFlow({
      tools: {
        read: { kind: "builtin", name: "Read" },
        cal: {
          kind: "builtin",
          name: "mcp__claude_ai_Google_Calendar__list_events",
          targets: ["claude"],
        },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "Read, then {{#claude}}call {{tool:cal}}{{/claude}}.",
              toolCalls: ["read", "cal"],
              next: null,
            },
          ],
        },
      ],
    })
    const claudeOut = renderMarkdown(flow, TARGETS.claude)
    const cursorOut = renderMarkdown(flow, TARGETS.cursor)
    // Claude keeps the calendar tool in allowed-tools and in prose.
    expect(claudeOut).toContain(
      'allowed-tools: ["Read", "mcp__claude_ai_Google_Calendar__list_events"]',
    )
    expect(claudeOut).toContain("`mcp__claude_ai_Google_Calendar__list_events`")
    // Cursor drops it entirely: gated prose stripped, and deriving its
    // allowed-tools does not throw on the now-absent Claude-only tool.
    // (Cursor frontmatter emits no `allowed-tools` line; the proof is the
    // successful render with the calendar clause gone.)
    expect(cursorOut).not.toContain("Google_Calendar")
    expect(cursorOut).toContain("Read, then .")
  })

  it("throws when a Claude-only {{tool:id}} is not gated for other agents", () => {
    const flow = makeFlow({
      tools: {
        cal: {
          kind: "builtin",
          name: "mcp__claude_ai_Google_Calendar__list_events",
          targets: ["claude"],
        },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              // Ungated: reaches cursor prose and must error.
              body: "Call {{tool:cal}}.",
              toolCalls: ["cal"],
              next: null,
            },
          ],
        },
      ],
    })
    expect(renderMarkdown(flow, TARGETS.claude)).toContain("Google_Calendar")
    expect(() => renderMarkdown(flow, TARGETS.cursor)).toThrow(
      /not available on target "cursor"/,
    )
  })

  // A split sub-skill's allowed-tools is derived per-phase (collectPhaseToolIds),
  // so a phase whose only Bash use is a command or the activity emit — not
  // a `{{tool:bash}}` reference — would otherwise omit Bash and deny the command
  // at runtime. The monolith's union hides this; the split path must not.
  it("derives Bash for a split sub-skill that invokes a command", () => {
    const flow = makeFlow({
      entries: { main: "work/do" },
      defaultMode: "main",
      compile: { mode: "split-chain", inlinePhases: [] },
      tools: {
        bash: { kind: "builtin", name: "Bash" },
        read: { kind: "builtin", name: "Read" },
      },
      commands: { ping: { file: "ping.js", description: "Ping" } },
      phases: [
        {
          id: "work",
          title: "Work",
          stepStyle: "list",
          steps: [
            {
              id: "do",
              kind: "action",
              title: "Do",
              // Command usage, but toolCalls lists only Read.
              body: "Run `{{command:ping}}`.",
              toolCalls: ["read"],
              next: null,
            },
          ],
        },
      ],
    })
    const sub = renderFlow(flow, TARGETS.claude).find((f) => f.slug === "work")
    expect(sub?.content).toContain('allowed-tools: ["Bash", "Read"]')
  })

  it("derives Bash for a split sub-skill whose only Bash use is a command-based emit", () => {
    const flow = makeFlow({
      entries: { main: "work/do" },
      defaultMode: "main",
      compile: { mode: "split-chain", inlinePhases: [] },
      tools: {
        ask: { kind: "builtin", name: "AskUserQuestion" },
        bash: { kind: "builtin", name: "Bash" },
      },
      commands: { activity: { file: "activity.js", description: "Activity" } },
      emitTemplate: "Activity: {{command:activity}} {displayName}",
      phases: [
        {
          id: "work",
          title: "Work",
          stepStyle: "list",
          steps: [
            {
              id: "do",
              kind: "action",
              title: "Do",
              body: "x",
              emit: "Working",
              toolCalls: ["ask"],
              next: null,
            },
          ],
        },
      ],
    })
    const sub = renderFlow(flow, TARGETS.claude).find((f) => f.slug === "work")
    // The emit runs a command via Bash, so Bash joins ask in allowed-tools.
    expect(sub?.content).toContain('allowed-tools: ["AskUserQuestion", "Bash"]')
  })
})

describe("Renderer: command registry and {{command:id}}", () => {
  it("resolves {{command:id}} to the full invocation path", () => {
    const flow = makeFlow({
      commands: {
        login: {
          file: "login.js",
          description: "Authenticate via browser OAuth",
        },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "Run `{{command:login}}`.",
              next: null,
            },
          ],
        },
      ],
    })
    const claudeOut = renderMarkdown(flow, TARGETS.claude)
    expect(claudeOut).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variable in expected output, not a JS template
      'Run `node "${CLAUDE_PLUGIN_ROOT}/dist/commands/login.js"`.',
    )
    const codexOut = renderMarkdown(flow, TARGETS.codex)
    expect(codexOut).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell variable in expected output, not a JS template
      'Run `node "${ACME_PLUGIN_DIR}/dist/commands/login.js"`.',
    )
  })

  it("renders a CLI commands reference table after the intro", () => {
    const flow = makeFlow({
      intro: "Intro text.",
      commands: {
        status: {
          file: "status.js",
          description: "Check status",
        },
        login: {
          file: "login.js",
          description: "Authenticate via OAuth",
          args: "--headless",
        },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "Body",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("**CLI commands**")
    expect(out).toContain("| `status.js` | Check status |")
    expect(out).toContain("| `login.js --headless` | Authenticate via OAuth |")
  })

  it("omits the CLI commands table when no commands are declared", () => {
    const flow = makeFlow({
      intro: "Intro text.",
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "Body",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).not.toContain("**CLI commands**")
  })
})

describe("Renderer: branches and {{branches}}", () => {
  it("renders user-choice options as a blockquote-prefixed list", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "branch",
              title: "Pick",
              body: "Choose:\n\n{{branches}}",
              branches: [
                {
                  option: { letter: "A", label: "Apple" },
                  recommended: true,
                  next: null,
                },
                {
                  option: {
                    letter: "B",
                    label: "Banana",
                    description: "yellow fruit",
                  },
                  next: null,
                },
              ],
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("> A) **Apple** *(recommended)*")
    expect(out).toContain("> B) **Banana**: yellow fruit")
  })

  it("filters {{branches:tag}} to only options with matching prompt tag", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "branch",
              title: "Pick",
              body: "First:\n{{branches:first}}\n\nSecond:\n{{branches:second}}",
              branches: [
                {
                  prompt: "first",
                  option: { letter: "A", label: "First A" },
                  next: null,
                },
                {
                  prompt: "second",
                  option: { letter: "A", label: "Second A" },
                  next: null,
                },
              ],
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("First:\n> A) **First A**")
    expect(out).toContain("Second:\n> A) **Second A**")
  })

  it("excludes runtime branches (no `option`) from the {{branches}} block", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "branch",
              title: "Pick",
              body: "{{branches}}",
              branches: [
                { when: "exit condition", next: null },
                {
                  option: { letter: "A", label: "User choice" },
                  next: null,
                },
              ],
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("> A) **User choice**")
    expect(out).not.toContain("exit condition")
  })
})

describe("Renderer: whens and {{whens}}", () => {
  it("renders runtime when-branches as a bullet list with descriptions", () => {
    const flow = makeFlow({
      entries: { all: "main/decide" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "decide",
              kind: "branch",
              title: "Decide",
              body: "After running the check, route on the outcome:\n\n{{whens}}",
              branches: [
                {
                  when: "not authenticated",
                  description: "stop the flow and prompt for login",
                  next: null,
                },
                {
                  when: "authenticated",
                  description: "continue to the next step",
                  next: "main/done",
                },
              ],
            },
            {
              id: "done",
              kind: "action",
              title: "Done",
              body: "End",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain(
      "- **not authenticated**: stop the flow and prompt for login",
    )
    expect(out).toContain("- **authenticated**: continue to the next step")
  })

  it("falls back to 'stop the flow' for null next without description", () => {
    const flow = makeFlow({
      entries: { all: "main/decide" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "decide",
              kind: "branch",
              title: "Decide",
              body: "{{whens}}",
              branches: [
                { when: "fail case", next: null },
                { when: "ok case", next: "main/done" },
              ],
            },
            {
              id: "done",
              kind: "action",
              title: "Done",
              body: "End",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("- **fail case**: stop the flow")
    expect(out).toContain("- **ok case**: continue")
  })

  it("excludes user-choice (option) branches from the {{whens}} render", () => {
    const flow = makeFlow({
      entries: { all: "main/decide" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "decide",
              kind: "branch",
              title: "Decide",
              body: "Whens:\n\n{{whens}}\n\nBranches:\n\n{{branches}}",
              branches: [
                { when: "runtime case", next: "main/done" },
                {
                  option: { letter: "A", label: "User choice" },
                  next: "main/done",
                },
              ],
            },
            {
              id: "done",
              kind: "action",
              title: "Done",
              body: "End",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("- **runtime case**: continue")
    expect(out).toContain("> A) **User choice**")
    // The option branch must not appear in the {{whens}} block
    expect(out).not.toContain("- **User choice**")
  })

  it("substitutes {{tool:…}} and Mustache sections inside descriptions", () => {
    const flow = makeFlow({
      entries: { all: "main/decide" },
      tools: { ask: { kind: "builtin", name: "AskUserQuestion" } },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "decide",
              kind: "branch",
              title: "Decide",
              body: "{{whens}}",
              branches: [
                {
                  when: "ok",
                  description:
                    "call {{tool:ask}} {{#claude}}on claude{{/claude}}{{^claude}}elsewhere{{/claude}}",
                  next: "main/done",
                },
                { when: "fail", next: null },
              ],
            },
            {
              id: "done",
              kind: "action",
              title: "Done",
              body: "End",
              next: null,
            },
          ],
        },
      ],
    })
    const claudeOut = renderMarkdown(flow, TARGETS.claude)
    const codexOut = renderMarkdown(flow, TARGETS.codex)
    expect(claudeOut).toContain("call `AskUserQuestion` on claude")
    expect(codexOut).toContain("call `AskUserQuestion` elsewhere")
  })
})

describe("Renderer: tables", () => {
  const oneStep = (body: string) => [
    {
      id: "main",
      title: "Main",
      stepStyle: "headers",
      steps: [{ id: "a", kind: "action", title: "A", body, next: null }],
    },
  ]

  it("renders {{list:name:col}} as bullets of label: value", () => {
    const flow = makeFlow({
      tables: {
        sdks: {
          rows: [
            { key: "ts", label: "TypeScript", cells: { imports: "`acme`" } },
            { key: "py", label: "Python", cells: { imports: "`acme-py`" } },
            { key: "go", cells: {} },
          ],
        },
      },
      phases: oneStep("Imports:\n{{list:sdks:imports}}"),
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("Imports:\n- TypeScript: `acme`\n- Python: `acme-py`")
    expect(out).not.toContain("go:")
  })

  it("renders {{table:name:f1,f2}} with the key column and derived headers", () => {
    const flow = makeFlow({
      tables: {
        sdks: {
          keyHeader: "Language",
          rows: [
            {
              key: "ts",
              cells: { detection: "pkg.json", outdated: "npm outdated" },
            },
            { key: "rb", cells: { detection: "Gemfile" } },
          ],
        },
      },
      phases: oneStep("{{table:sdks:detection,outdated}}"),
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("| Language | Detection | Outdated |")
    expect(out).toContain("| ts | pkg.json | npm outdated |")
    // Rows missing a requested column are skipped.
    expect(out).not.toContain("| rb |")
  })

  it("uses column header overrides when set", () => {
    const flow = makeFlow({
      tables: {
        sdks: {
          columns: { detection: "Custom Header" },
          rows: [{ key: "ts", cells: { detection: "pkg.json" } }],
        },
      },
      phases: oneStep("{{table:sdks:detection}}"),
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("| Name | Custom Header |")
  })

  it("rejects a placeholder naming an undeclared table at parse time", () => {
    expect(() => makeFlow({ phases: oneStep("{{table:nope:x}}") })).toThrow(
      /undeclared table/,
    )
  })
})

describe("Renderer: step references", () => {
  it("resolves {{step:phase/id}} to the step's number", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "see step {{step:main/c}}",
              next: "main/b",
            },
            { id: "b", kind: "action", title: "B", body: "b", next: "main/c" },
            { id: "c", kind: "action", title: "C", body: "c", next: null },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("see step 3")
  })

  it("resolves {{step-ref:phase/id}} to the step's title when refName is unset", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "see the {{step-ref:main/c}} step",
              next: "main/c",
            },
            {
              id: "c",
              kind: "action",
              title: "Create the release",
              body: "c",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("see the Create the release step")
  })

  it("resolves {{step-ref:phase/id}} to refName when set", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "see the {{step-ref:main/c}} step",
              next: "main/c",
            },
            {
              id: "c",
              kind: "action",
              title: "Create the release",
              refName: "release",
              body: "c",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("see the release step")
  })

  it("throws on a {{step-ref:id}} that doesn't exist", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "see the {{step-ref:main/ghost}} step",
              next: null,
            },
          ],
        },
      ],
    })
    expect(() => renderMarkdown(flow, TARGETS.claude)).toThrow(
      /not found in flow/,
    )
  })

  it("renders preamble step's number as 0 in references", () => {
    const flow = makeFlow({
      entries: { all: "main/p" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "p",
              kind: "action",
              title: "P",
              body: "p",
              preamble: true,
              next: "main/a",
            },
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "see step {{step:main/p}}",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("see step 0")
  })

  it("throws on a {{step:id}} that doesn't exist", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "see step {{step:main/ghost}}",
              next: null,
            },
          ],
        },
      ],
    })
    expect(() => renderMarkdown(flow, TARGETS.claude)).toThrow(
      /not found in flow/,
    )
  })
})

describe("Renderer: Targetable string fields", () => {
  it("uses target-specific value when provided", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: { default: "default body", codex: "codex body" },
              next: null,
            },
          ],
        },
      ],
    })
    expect(renderMarkdown(flow, TARGETS.claude)).toContain("default body")
    expect(renderMarkdown(flow, TARGETS.codex)).toContain("codex body")
  })
})

describe("Renderer: variables", () => {
  it("substitutes the target argument token in flow prose", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "Read {{argsToken}} first.",
              next: null,
            },
          ],
        },
      ],
    })

    expect(renderMarkdown(flow, TARGETS.claude)).toContain(
      "Read $ARGUMENTS first.",
    )
    expect(renderMarkdown(flow, TARGETS.amp)).toContain(
      "Read the user's request first.",
    )
  })

  it("substitutes {{name}} from flow.variables", () => {
    const flow = makeFlow({
      variables: { greeting: "hello" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "Say {{greeting}}!",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("Say hello!")
  })

  it("resolves a per-target variable to the target's value", () => {
    const flow = makeFlow({
      variables: {
        siteName: { default: "Acme", codex: "Acme Codex" },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "Welcome to {{siteName}}.",
              next: null,
            },
          ],
        },
      ],
    })
    expect(renderMarkdown(flow, TARGETS.claude)).toContain("Welcome to Acme.")
    expect(renderMarkdown(flow, TARGETS.codex)).toContain(
      "Welcome to Acme Codex.",
    )
  })
})

describe("Renderer: substitution ordering", () => {
  it("strips non-matching Mustache sections before resolving inner step refs", () => {
    // Reproduces the Cursor Bugbot case: a step reference inside a
    // {{#codex}} section must not be resolved against Claude's step
    // numbering when rendering for Claude. Stripping sections first
    // means the placeholder is removed before any resolution attempt.
    const flow = makeFlow({
      entries: {
        all: { default: "main/start", codex: "main/codex-only" },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "codex-only",
              kind: "action",
              title: "Codex Preamble",
              body: "p",
              preamble: true,
              next: "main/start",
            },
            {
              id: "start",
              kind: "action",
              title: "Start",
              body: "before {{#codex}}see step {{step:main/codex-only}}{{/codex}} after",
              next: null,
            },
          ],
        },
      ],
    })
    // Claude doesn't have main/codex-only in its reachable set; the
    // {{step:...}} reference inside the {{#codex}} block should be
    // stripped before evaluation.
    expect(() => renderMarkdown(flow, TARGETS.claude)).not.toThrow()
    const claudeOut = renderMarkdown(flow, TARGETS.claude)
    expect(claudeOut).toContain("before  after")
    // Codex sees its own preamble and the step reference resolves to 0.
    const codexOut = renderMarkdown(flow, TARGETS.codex)
    expect(codexOut).toContain("before see step 0 after")
  })
})

describe("Renderer: Mustache sections", () => {
  it("includes #target content only for the matching target", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "before {{#codex}}codex-only{{/codex}} after",
              next: null,
            },
          ],
        },
      ],
    })
    expect(renderMarkdown(flow, TARGETS.claude)).toContain("before  after")
    expect(renderMarkdown(flow, TARGETS.codex)).toContain(
      "before codex-only after",
    )
  })

  it("inverts for ^target sections", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "{{^codex}}non-codex{{/codex}}",
              next: null,
            },
          ],
        },
      ],
    })
    expect(renderMarkdown(flow, TARGETS.claude)).toContain("non-codex")
    expect(renderMarkdown(flow, TARGETS.codex)).not.toContain("non-codex")
  })

  it("throws on an unknown Mustache section name", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "{{#nottarget}}x{{/nottarget}}",
              next: null,
            },
          ],
        },
      ],
    })
    expect(() => renderMarkdown(flow, TARGETS.claude)).toThrow(
      /Unknown section "nottarget"/,
    )
  })
})

describe("Renderer: per-mode sections", () => {
  /** Two modes, each entering its own phase, plus a phase both can reach. */
  function twoModeFlow(body: string, compileMode = "monolith"): Flow {
    return Flow.parse({
      schemaVersion: 1,
      id: "test",
      title: "Test",
      frontmatter: { description: "Desc" },
      entries: { alpha: "alpha/start", beta: "beta/start" },
      defaultMode: "alpha",
      compile: { mode: compileMode, inlinePhases: [] },
      phases: [
        {
          id: "alpha",
          title: "Alpha",
          stepStyle: "headers",
          steps: [
            {
              id: "start",
              kind: "action",
              title: "Alpha start",
              body: "alpha",
              next: "shared/both",
            },
          ],
        },
        {
          id: "beta",
          title: "Beta",
          stepStyle: "headers",
          steps: [
            {
              id: "start",
              kind: "action",
              title: "Beta start",
              body: "beta",
              next: "shared/both",
            },
          ],
        },
        {
          id: "shared",
          title: "Shared",
          stepStyle: "headers",
          steps: [
            { id: "both", kind: "action", title: "Both", body, next: null },
          ],
        },
      ],
    })
  }

  it("gates the content when the file serves more than one mode", () => {
    const rendered = renderMarkdown(
      twoModeFlow("{{#mode:beta}}beta-only{{/mode:beta}}"),
      TARGETS.claude,
    )
    expect(rendered).toContain("**Only when the mode is `beta`:**")
    expect(rendered).toContain("beta-only")
  })

  it("gates the inverse form too", () => {
    const rendered = renderMarkdown(
      twoModeFlow("{{^mode:beta}}not-beta{{/mode:beta}}"),
      TARGETS.claude,
    )
    expect(rendered).toContain("**Unless the mode is `beta`:**")
    expect(rendered).toContain("not-beta")
  })

  it("unwraps with no gate when the phase is reachable in that mode only", () => {
    // Under split-chain each phase is its own file, so the `alpha` sub-skill
    // is single-mode and the section resolves statically.
    const files = renderFlow(
      Flow.parse({
        schemaVersion: 1,
        id: "test",
        title: "Test",
        frontmatter: { description: "Desc" },
        entries: { alpha: "alpha/start", beta: "beta/start" },
        defaultMode: "alpha",
        compile: { mode: "split-chain", inlinePhases: [] },
        phases: [
          {
            id: "alpha",
            title: "Alpha",
            stepStyle: "headers",
            steps: [
              {
                id: "start",
                kind: "action",
                title: "Alpha start",
                body:
                  "{{#mode:alpha}}alpha-only{{/mode:alpha}}" +
                  "{{^mode:alpha}}dropped{{/mode:alpha}}" +
                  "{{#mode:beta}}unreachable{{/mode:beta}}",
                next: null,
              },
            ],
          },
          {
            id: "beta",
            title: "Beta",
            stepStyle: "headers",
            steps: [
              {
                id: "start",
                kind: "action",
                title: "Beta start",
                body: "beta",
                next: null,
              },
            ],
          },
        ],
      }),
      TARGETS.claude,
    )
    const alpha = files.find((f) => f.slug === "alpha")
    expect(alpha?.content).toContain("alpha-only")
    expect(alpha?.content).not.toContain("Only when the mode is")
    // The inverse of the only mode, and a mode that never reaches this file,
    // are both dead content.
    expect(alpha?.content).not.toContain("dropped")
    expect(alpha?.content).not.toContain("unreachable")
  })

  it("never leaks an unresolved mode section into output", () => {
    const rendered = renderMarkdown(
      twoModeFlow(
        "{{#mode:beta}}x{{/mode:beta}}{{^mode:alpha}}y{{/mode:alpha}}",
      ),
      TARGETS.claude,
    )
    expect(rendered).not.toMatch(/\{\{[#^/]mode:/)
  })

  it("rejects a section naming a mode the flow does not declare", () => {
    expect(() => twoModeFlow("{{#mode:gamma}}x{{/mode:gamma}}")).toThrow(
      /names a mode that does not exist/,
    )
  })
})

describe("Renderer: invariants", () => {
  it("renders an `## Invariants` section between intro and phases", () => {
    const flow = makeFlow({
      intro: "Intro paragraph.",
      invariants: ["First rule", "Second rule"],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("## Invariants\n\n- First rule\n- Second rule")
    // Must come after intro, before the first phase's content.
    const introIdx = out.indexOf("Intro paragraph.")
    const invariantsIdx = out.indexOf("## Invariants")
    const firstStepIdx = out.indexOf("## 1.")
    expect(introIdx).toBeGreaterThan(0)
    expect(invariantsIdx).toBeGreaterThan(introIdx)
    expect(firstStepIdx).toBeGreaterThan(invariantsIdx)
  })

  it("omits the section entirely when invariants is empty", () => {
    const flow = makeFlow({ invariants: [] })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).not.toContain("## Invariants")
  })

  it("omits the section by default (field defaults to empty array)", () => {
    const flow = makeFlow()
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).not.toContain("## Invariants")
  })

  it("substitutes {{tool:…}} placeholders inside invariant strings", () => {
    const flow = makeFlow({
      tools: { ask: { kind: "builtin", name: "AskUserQuestion" } },
      invariants: ["Always use {{tool:ask}} for decisions"],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("Always use `AskUserQuestion` for decisions")
  })

  it("respects Mustache sections inside invariant strings", () => {
    const flow = makeFlow({
      invariants: [
        "Rule that {{#codex}}codex says X{{/codex}}{{^codex}}others say Y{{/codex}}",
      ],
    })
    const claudeOut = renderMarkdown(flow, TARGETS.claude)
    const codexOut = renderMarkdown(flow, TARGETS.codex)
    expect(claudeOut).toContain("Rule that others say Y")
    expect(codexOut).toContain("Rule that codex says X")
  })
})

describe("Renderer: unknown-placeholder safety net", () => {
  it("throws on an unrecognized {{name}} placeholder", () => {
    const flow = makeFlow({
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "a",
              kind: "action",
              title: "A",
              body: "see {{ghost}}",
              next: null,
            },
          ],
        },
      ],
    })
    expect(() => renderMarkdown(flow, TARGETS.claude)).toThrow(
      /Unresolved placeholder/,
    )
  })
})

describe("renderFlow", () => {
  it("returns a single monolith file equal to renderMarkdown", () => {
    const flow = makeFlow()
    const files = renderFlow(flow, TARGETS.claude)
    expect(files).toHaveLength(1)
    expect(files[0].kind).toBe("monolith")
    expect(files[0].slug).toBe("")
    expect(files[0].content).toBe(renderMarkdown(flow, TARGETS.claude))
  })

  it("inlining every phase emits only an orchestrator (no sub-skills)", () => {
    const flow = makeFlow({
      compile: { mode: "split", inlinePhases: ["main"] },
    })
    const files = renderFlow(flow, TARGETS.claude)
    expect(files).toHaveLength(1)
    expect(files[0].kind).toBe("orchestrator")
    expect(files[0].slug).toBe("")
    // The inlined phase's step renders inside the orchestrator.
    expect(files[0].content).toContain("Body A")
  })

  it("splits a non-inline phase into the orchestrator plus a sub-skill", () => {
    const flow = makeFlow({
      compile: { mode: "split", inlinePhases: [] },
    })
    const files = renderFlow(flow, TARGETS.claude)
    expect(files).toHaveLength(2)

    const orchestrator = files.find((f) => f.kind === "orchestrator")
    const sub = files.find((f) => f.kind === "phase")
    expect(orchestrator?.slug).toBe("")
    expect(sub?.slug).toBe("main")

    // The orchestrator dispatches to the sub-skill by name and omits the body.
    expect(orchestrator?.content).toContain("Invoke the `test-main` skill")
    expect(orchestrator?.content).not.toContain("Body A")

    // The Claude sub-skill is an Agent Skill (name: frontmatter), hidden from
    // the `/` menu but model-invocable, carries the phase body and its own H1.
    expect(sub?.content).toContain("name: test-main")
    expect(sub?.content).toContain("user-invocable: false")
    expect(sub?.content).toContain("Body A")
    expect(sub?.content).toContain("# Test: Main")
  })

  it("names split sub-skills per target (Claude/Cursor/Codex frontmatter)", () => {
    const flow = makeFlow({ compile: { mode: "split", inlinePhases: [] } })

    // Dispatch wording is target-neutral (invoke by sub-skill name).
    for (const target of [
      TARGETS.claude,
      TARGETS.cursor,
      TARGETS.codex,
      TARGETS.amp,
    ]) {
      expect(
        renderFlow(flow, target).find((f) => f.kind === "orchestrator")
          ?.content,
      ).toContain("Invoke the `test-main` skill")
    }

    // Cursor prefixes skill names with `acme-`; Claude/Codex do not.
    expect(
      renderFlow(flow, TARGETS.cursor).find((f) => f.kind === "phase")?.content,
    ).toContain("name: acme-test-main")
    expect(
      renderFlow(flow, TARGETS.codex).find((f) => f.kind === "phase")?.content,
    ).toContain("name: test-main")
  })

  it("orchestrator allowed-tools include the Skill tool plus inline-phase tools", () => {
    const flow = makeFlow({
      tools: { bash: { kind: "builtin", name: "Bash" } },
      entries: { all: "setup/run" },
      compile: { mode: "split", inlinePhases: ["setup"] },
      phases: [
        {
          id: "setup",
          title: "Setup",
          stepStyle: "list",
          steps: [
            {
              id: "run",
              kind: "action",
              toolCalls: ["bash"],
              title: "Run",
              body: "Run it",
              next: "work/do",
            },
          ],
        },
        {
          id: "work",
          title: "Work",
          stepStyle: "list",
          steps: [
            {
              id: "do",
              kind: "action",
              title: "Do",
              body: "Do it",
              next: null,
            },
          ],
        },
      ],
    })
    const orchestrator = renderFlow(flow, TARGETS.claude).find(
      (f) => f.kind === "orchestrator",
    )
    expect(orchestrator?.content).toContain('allowed-tools: ["Bash", "Skill"]')
  })

  it("per-target mode splits one target; others stay monolith", () => {
    const flow = makeFlow({
      compile: { mode: { default: "monolith", claude: "split" } },
    })

    const claude = renderFlow(flow, TARGETS.claude)
    expect(claude).toHaveLength(2)
    expect(claude.map((f) => f.kind)).toEqual(["orchestrator", "phase"])

    for (const target of [TARGETS.cursor, TARGETS.codex, TARGETS.amp]) {
      const files = renderFlow(flow, target)
      expect(files).toHaveLength(1)
      expect(files[0].kind).toBe("monolith")
      expect(files[0].content).toBe(renderMarkdown(flow, target))
    }
  })
})

describe("Renderer: trait sections shared by several targets", () => {
  function traitFlow(body: string): Flow {
    return makeFlow({
      entries: { all: "main/a" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "list",
          steps: [{ id: "a", kind: "action", title: "A", body, next: null }],
        },
      ],
    })
  }

  it("ask-user-question matches the hosts that have the tool", () => {
    const flow = traitFlow(
      "{{#ask-user-question}}MENU{{/ask-user-question}}{{^ask-user-question}}PLAIN{{/ask-user-question}}",
    )
    for (const target of [TARGETS.claude, TARGETS.cursor]) {
      const out = renderMarkdown(flow, target)
      expect(out).toContain("MENU")
      expect(out).not.toContain("PLAIN")
    }
    for (const target of [TARGETS.codex, TARGETS.amp]) {
      const out = renderMarkdown(flow, target)
      expect(out).toContain("PLAIN")
      expect(out).not.toContain("MENU")
    }
  })

  it("plugin-dir-lookup renders each host's own resolver block", () => {
    const flow = traitFlow(
      "{{#plugin-dir-lookup}}Resolve first:\n\n{{pluginDirLookup}}{{/plugin-dir-lookup}}",
    )
    expect(renderMarkdown(flow, TARGETS.codex)).toContain("CODEX_HOME")
    expect(renderMarkdown(flow, TARGETS.amp)).toContain("amp/plugins/acme")
    expect(renderMarkdown(flow, TARGETS.claude)).not.toContain("Resolve first")
  })

  it("amp frontmatter names the skill after the flow and uses bare tool names", () => {
    const flow = makeFlow({
      tools: { key: { kind: "mcp", name: "get_acme_api_key" } },
      entries: { all: "main/a" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "list",
          steps: [
            {
              id: "a",
              kind: "action",
              toolCalls: ["key"],
              title: "A",
              body: "Call {{tool:key}}",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.amp)
    expect(out).toContain("name: test")
    expect(out).toContain("Call `get_acme_api_key`")
    expect(out).not.toContain("mcp__")
  })
})

describe("renderFlow: split-chain (tail-call dispatch)", () => {
  /**
   * Update-flow-shaped fixture: shared inline `setup` fanning out by mode,
   * a `plugin` phase that tails into `sdk` in `all` mode but terminates in
   * `plugin` mode, and a terminal `sdk` phase.
   */
  function makeChainFlow(overrides: Record<string, unknown> = {}): Flow {
    return makeFlow({
      entries: { all: "setup/run", plugin: "setup/run", sdk: "setup/run" },
      defaultMode: "all",
      modeHints: { all: "Update everything." },
      tools: { bash: { kind: "builtin", name: "Bash" } },
      compile: { mode: "split-chain", inlinePhases: ["setup"] },
      appendices: [
        { id: "rep", title: "Reporting", body: "How to report" },
        { id: "glob", title: "Global", body: "Global stuff" },
      ],
      phases: [
        {
          id: "setup",
          title: "Setup",
          stepStyle: "list",
          steps: [
            {
              id: "run",
              kind: "action",
              toolCalls: ["bash"],
              title: "Run",
              body: "Run the script",
              next: {
                byMode: {
                  all: "plugin/report",
                  plugin: "plugin/report",
                  sdk: "sdk/parse",
                },
              },
            },
          ],
        },
        {
          id: "plugin",
          title: "Update plugin",
          stepStyle: "list",
          steps: [
            {
              id: "report",
              kind: "action",
              toolCalls: ["bash"],
              title: "Report",
              body: "Report the plugin result",
              next: { byMode: { all: "sdk/parse", plugin: null, sdk: null } },
            },
          ],
        },
        {
          id: "sdk",
          title: "Update SDK",
          stepStyle: "list",
          steps: [
            {
              id: "parse",
              kind: "action",
              toolCalls: ["bash"],
              title: "Parse",
              body: "Parse the status",
              refs: ["rep"],
              next: null,
            },
          ],
        },
      ],
      ...overrides,
    })
  }

  function fileFor(flow: Flow, slug: string): string {
    const file = renderFlow(flow, TARGETS.claude).find((f) => f.slug === slug)
    if (file === undefined) {
      throw new Error(`no rendered file with slug "${slug}"`)
    }
    return file.content
  }

  it("never emits call-and-return dispatch prose", () => {
    const flow = makeChainFlow()
    for (const file of renderFlow(flow, TARGETS.claude)) {
      expect(file.content).not.toContain("then return here")
    }
  })

  it("emits the Modes dispatch block in the split-chain orchestrator", () => {
    const orchestrator = fileFor(makeChainFlow(), "")
    expect(orchestrator).toContain("## Modes")
    expect(orchestrator).toContain("| Mode | Trigger | What it does |")
    expect(orchestrator).toContain(
      "run `all` and treat `$ARGUMENTS` as its input",
    )
  })

  it("uses the dispatch routing sentence in split-chain (not 'section below')", () => {
    const orchestrator = fileFor(makeChainFlow(), "")
    expect(orchestrator).toContain(
      "Follow only the selected mode's path below.",
    )
    expect(orchestrator).not.toContain("Run only that mode's section below")
  })

  it("renders a named default mode's trigger as `<mode>` (default)", () => {
    const orchestrator = fileFor(makeChainFlow(), "")
    // `all` is the defaultMode but also a real token, unlike the synthetic
    // `default`, so it shows both.
    expect(orchestrator).toContain("| `all` | `all` (default) |")
  })

  it("emits the same file layout as split (orchestrator + per-phase sub-skills)", () => {
    const flow = makeChainFlow()
    const files = renderFlow(flow, TARGETS.claude)
    expect(files.map((f) => [f.kind, f.slug])).toEqual([
      ["orchestrator", ""],
      ["phase", "plugin"],
      ["phase", "sdk"],
    ])
  })

  it("renders a grouped byMode fan-out on the inline dispatching step", () => {
    const orchestrator = fileFor(makeChainFlow(), "")
    expect(orchestrator).toContain("**Next:**")
    expect(orchestrator).toContain(
      "- Mode `all` or `plugin`: invoke the `test-plugin` skill with the current mode (`all` or `plugin`), forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
    )
    expect(orchestrator).toContain(
      "- Mode `sdk`: invoke the `test-sdk` skill with mode `sdk`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
    )
  })

  it("forwards `$ARGUMENTS` on every dispatch edge (Next + Dispatch)", () => {
    // The mode literal alone never carries the user's non-mode argument (audit
    // scope, PR target, bump names, ...). Every line that hands off to a
    // sub-skill must forward `$ARGUMENTS` so the sub-skill reads the same input
    // the monolith did. Every line that hands off to a sub-skill carries the
    // forwarding clause.
    const orchestrator = fileFor(makeChainFlow(), "")
    const dispatchLines = orchestrator
      .split("\n")
      .filter((l) => /invoke the .* skill/.test(l))
    expect(dispatchLines.length).toBeGreaterThan(0)
    for (const line of dispatchLines) {
      expect(line).toContain(
        "forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
      )
    }
  })

  it("renders each target's own argsToken, never a hardcoded `$ARGUMENTS`", () => {
    // The renderer must not bake in Claude's `$ARGUMENTS`: a target that names
    // its argument placeholder differently should see ITS token in both the
    // Modes routing preamble and every dispatch line. This keeps the split-chain
    // machinery target-agnostic (the coupling lives in `target.argsToken`, not
    // in render.ts). makeChainFlow's bodies contain no `$ARGUMENTS`, so the only
    // source in the orchestrator is the renderer.
    const custom = { ...TARGETS.claude, argsToken: "%%ARGS%%" }
    const orchestrator =
      renderFlow(makeChainFlow(), custom).find((f) => f.kind === "orchestrator")
        ?.content ?? ""
    expect(orchestrator).toContain("Read `%%ARGS%%` first.")
    expect(orchestrator).toContain(
      "forwarding `%%ARGS%%` minus the leading mode keyword (if the user typed one).",
    )
    expect(orchestrator).not.toContain("$ARGUMENTS")
  })

  it("folds a single-mode inline phase gate under its step heading, not above it", () => {
    // An inline `main` holding only a help step is single-mode, so it gets a
    // `phaseGate`. Headers-style phases render no phase heading, so the gate used
    // to float above the first step - in a split-chain orchestrator that put it
    // right under `## Dispatch`, reading as if it gated the dispatch. It must sit
    // UNDER the first step heading instead.
    const flow = makeFlow({
      entries: { default: "run/do", help: "main/help" },
      defaultMode: "default",
      modeHints: { default: "Do the thing.", help: "Show help." },
      tools: { bash: { kind: "builtin", name: "Bash" } },
      compile: { mode: "split-chain", inlinePhases: ["main"] },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "help",
              kind: "action",
              preamble: true,
              title: "Help shortcut",
              body: "Show usage",
              next: null,
            },
          ],
        },
        {
          id: "run",
          title: "Run",
          stepStyle: "headers",
          steps: [
            {
              id: "do",
              kind: "action",
              toolCalls: ["bash"],
              title: "Do it",
              body: "Do the work",
              next: null,
            },
          ],
        },
      ],
    })
    const orchestrator =
      renderFlow(flow, TARGETS.claude).find((f) => f.kind === "orchestrator")
        ?.content ?? ""
    // Gate is folded directly under the step heading.
    expect(orchestrator).toContain(
      "## 0. Help shortcut\n\n**Run only when mode is `help`.**",
    )
    // And it appears after the heading, never floating above it (under Dispatch).
    expect(
      orchestrator.indexOf("**Run only when mode is `help`.**"),
    ).toBeGreaterThan(orchestrator.indexOf("## 0. Help shortcut"))
  })

  it("points an interactive default overview at the `## Dispatch` block under split-chain", () => {
    // A no-argument `default` mode that is an inline overview asking the user to
    // pick a mode dead-ends under split-chain: the modes it offers live in
    // sub-skills reached only via `## Dispatch`, and the terminal overview
    // (`next: null`) has no dispatch edge of its own. The renderer must append a
    // pointer so the interactive choice still routes. Monolith keeps every mode
    // inline under the menu, so it must NOT get the pointer.
    const flow = makeFlow({
      entries: {
        default: "main/overview",
        build: "build/run",
        deploy: "deploy/run",
      },
      defaultMode: "default",
      modeHints: {
        default: "No subcommand: show the modes and ask which to run.",
        build: "Build it.",
        deploy: "Deploy it.",
      },
      tools: { bash: { kind: "builtin", name: "Bash" } },
      compile: {
        mode: { default: "monolith", claude: "split-chain" },
        inlinePhases: ["main"],
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "overview",
              kind: "action",
              preamble: true,
              title: "Overview",
              body: "Show the modes and ask which one to run.",
              next: null,
            },
          ],
        },
        {
          id: "build",
          title: "Build",
          stepStyle: "headers",
          steps: [
            {
              id: "run",
              kind: "action",
              toolCalls: ["bash"],
              title: "Build",
              body: "Build it",
              next: null,
            },
          ],
        },
        {
          id: "deploy",
          title: "Deploy",
          stepStyle: "headers",
          steps: [
            {
              id: "run",
              kind: "action",
              toolCalls: ["bash"],
              title: "Deploy",
              body: "Deploy it",
              next: null,
            },
          ],
        },
      ],
    })
    const pointer =
      "**Next:** once the user picks a mode, invoke that mode's skill from the `## Dispatch` section above, forwarding the arguments the user gave with their pick minus the mode keyword. Ignore the dispatch lines' `$ARGUMENTS` here: this is the no-argument entry, so it is empty and the user's pick is the only source of those arguments."
    const claudeOrch =
      renderFlow(flow, TARGETS.claude).find((f) => f.kind === "orchestrator")
        ?.content ?? ""
    expect(claudeOrch).toContain("## Dispatch")
    expect(claudeOrch).toContain(pointer)
    // The pointer sits after the `## Dispatch` block it references.
    expect(claudeOrch.indexOf(pointer)).toBeGreaterThan(
      claudeOrch.indexOf("## Dispatch"),
    )
    // Cursor compiles this flow monolith: the modes render inline under the
    // menu, so the pointer would be wrong. It must be absent.
    expect(renderMarkdown(flow, TARGETS.cursor)).not.toContain(pointer)
    // A split-chain flow with no interactive inline default (its modes all enter
    // sub-phases directly, no `default` entry) must not get the pointer either.
    const nonInteractive = renderFlow(makeChainFlow(), TARGETS.claude).find(
      (f) => f.kind === "orchestrator",
    )?.content
    expect(nonInteractive).not.toContain(pointer)
    const codexFlow = Flow.parse({
      ...flow,
      compile: { ...flow.compile, mode: "split-chain" },
    })
    expect(renderFlow(codexFlow, TARGETS.codex)[0].content).toContain(
      "once the user picks a mode, read and follow that mode's reference",
    )
  })

  it("resolves {{skill-ref}} to a skill under split-chain and a section under monolith", () => {
    // {{skill-ref:phase}} lets routing prose (e.g. a gate override jumping to a
    // terminal phase) name where that phase lives, mode-aware: a sub-skill under
    // split-chain, a same-file section under monolith. Hardcoding either word
    // breaks the other mode.
    const flow = makeFlow({
      entries: { default: "main/survey", help: "main/help" },
      defaultMode: "default",
      modeHints: { default: "Run.", help: "Help." },
      tools: { bash: { kind: "builtin", name: "Bash" } },
      compile: {
        mode: { default: "monolith", claude: "split-chain" },
        inlinePhases: ["main"],
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "help",
              kind: "action",
              preamble: true,
              title: "Help",
              body: "Help",
              next: null,
            },
            {
              id: "survey",
              kind: "action",
              title: "Survey",
              body: "On the no-op gate, go straight to {{skill-ref:report}}.",
              next: { byMode: { default: "report/report", help: null } },
            },
          ],
        },
        {
          id: "report",
          title: "Report",
          stepStyle: "headers",
          steps: [
            {
              id: "report",
              kind: "action",
              toolCalls: ["bash"],
              title: "Report",
              body: "Report it",
              next: null,
            },
          ],
        },
      ],
    })
    // Split-chain (claude): `report` compiles to its own sub-skill.
    const claudeOrch =
      renderFlow(flow, TARGETS.claude).find((f) => f.kind === "orchestrator")
        ?.content ?? ""
    expect(claudeOrch).toContain("go straight to the `test-report` skill.")
    // Monolith (cursor): `report` is a section in the same file.
    expect(renderMarkdown(flow, TARGETS.cursor)).toContain(
      "go straight to the *Report* section.",
    )
  })

  it("resolves {{dispatch-ref}} to a mode-carrying skill dispatch under split-chain and a section under monolith", () => {
    // {{dispatch-ref:phase}} is for prose that dispatches to a phase while
    // bypassing the auto-generated `**Next:**` block (gate overrides). Under
    // split-chain the target sub-skill gates on its dispatched mode, so the ref
    // must carry "with the current mode, forwarding `$ARGUMENTS`" — otherwise the
    // mode + args the `**Next:**` block would have passed are dropped. Under
    // monolith the phase is inline with the mode already in scope, so it degrades
    // to the same section reference as {{skill-ref}}.
    const flow = makeFlow({
      entries: { default: "main/survey", help: "main/help" },
      defaultMode: "default",
      modeHints: { default: "Run.", help: "Help." },
      tools: { bash: { kind: "builtin", name: "Bash" } },
      compile: {
        mode: { default: "monolith", claude: "split-chain" },
        inlinePhases: ["main"],
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "help",
              kind: "action",
              preamble: true,
              title: "Help",
              body: "Help",
              next: null,
            },
            {
              id: "survey",
              kind: "action",
              title: "Survey",
              body: "On the no-op gate, go straight to {{dispatch-ref:report}}.",
              next: { byMode: { default: "report/report", help: null } },
            },
          ],
        },
        {
          id: "report",
          title: "Report",
          stepStyle: "headers",
          steps: [
            {
              id: "report",
              kind: "action",
              toolCalls: ["bash"],
              title: "Report",
              body: "Report it",
              next: null,
            },
          ],
        },
      ],
    })
    // Split-chain (claude): `report` is its own mode-gated sub-skill, so the ref
    // carries the mode + argument token the bypassed `**Next:**` block would have.
    const claudeOrch =
      renderFlow(flow, TARGETS.claude).find((f) => f.kind === "orchestrator")
        ?.content ?? ""
    expect(claudeOrch).toContain(
      "go straight to the `test-report` skill with the current mode, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
    )
    // Monolith (cursor): `report` is inline, mode already in scope — degrades to
    // the plain section reference (no mode/args clause).
    const cursorMd = renderMarkdown(flow, TARGETS.cursor)
    expect(cursorMd).toContain("go straight to the *Report* section.")
    expect(cursorMd).not.toContain("with the current mode, forwarding")
  })

  it("loads Codex chain phases as references without discoverable sub-skills", () => {
    // Codex cannot hide phase skills from suggestions. Ordinary reference
    // files preserve progressive loading without adding skill metadata.
    const files = renderFlow(makeChainFlow(), TARGETS.codex)
    expect(files.map((file) => [file.kind, file.slug])).toEqual([
      ["orchestrator", ""],
      ["reference", "plugin"],
      ["reference", "sdk"],
    ])
    const orchestrator = files.find((f) => f.kind === "orchestrator")?.content
    expect(orchestrator).toContain(
      "- Mode `all` or `plugin`: read and follow the [Update plugin](references/plugin.md) reference with the current mode (`all` or `plugin`), forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
    )
    expect(orchestrator).toContain(
      "- Mode `sdk`: read and follow the [Update SDK](references/sdk.md) reference with mode `sdk`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
    )
    expect(orchestrator).toContain("use this worktree skill's directory")
    const plugin = files.find((file) => file.slug === "plugin")?.content
    expect(plugin).toContain(
      "- Mode `all`: read and follow the [Update SDK](./sdk.md) reference with mode `all`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
    )
    expect(plugin).toContain("- Mode `plugin`: stop here.")
    const sdk = files.find((file) => file.slug === "sdk")?.content
    expect(sdk).toContain("How to report")
    expect(sdk).not.toContain("**Next:**")
    for (const file of files.filter((file) => file.kind === "reference")) {
      expect(file.content).not.toMatch(/^---\n/)
      expect(file.content).not.toContain("Invoke with")
      expect(file.content).not.toContain("$acme:test-")
    }
    // Claude stays on the bare name (resolved via its `Skill` tool).
    const claudeOrch = renderFlow(makeChainFlow(), TARGETS.claude).find(
      (f) => f.kind === "orchestrator",
    )?.content
    expect(claudeOrch).toContain("invoke the `test-plugin` skill")
    expect(claudeOrch).not.toContain("$acme:")
  })

  it("routes Codex entry modes directly into references", () => {
    const files = renderFlow(
      makeChainFlow({
        compile: { mode: "split-chain", inlinePhases: [] },
      }),
      TARGETS.codex,
    )
    expect(files[0].content).toContain(
      "- Mode `all` or `plugin` or `sdk`: read and follow the [Setup](references/setup.md) reference with the current mode (`all` or `plugin` or `sdk`)",
    )
    expect(files.find((file) => file.slug === "setup")?.content).toContain(
      "[Update plugin](./plugin.md)",
    )
  })

  it("resolves Codex phase placeholders from the file containing them", () => {
    const base = makeChainFlow()
    const flow = makeChainFlow({
      phases: base.phases.map((phase) => ({
        ...phase,
        steps: phase.steps.map((step) => ({
          ...step,
          body: "See {{skill-ref:sdk}}. Go to {{dispatch-ref:sdk}}.",
        })),
      })),
    })
    const files = renderFlow(flow, TARGETS.codex)
    expect(files[0].content).toContain(
      "See the [Update SDK](references/sdk.md) reference.",
    )
    const plugin = files.find((file) => file.slug === "plugin")?.content
    expect(plugin).toContain("See the [Update SDK](./sdk.md) reference.")
    expect(plugin).toContain(
      "Go to the [Update SDK](./sdk.md) reference with the current mode, forwarding `$ARGUMENTS`",
    )
    expect(files.find((file) => file.slug === "sdk")?.content).toContain(
      "See the *Update SDK* section.",
    )
  })

  it("contrasts dispatch against done when one mode tails on and another terminates", () => {
    const plugin = fileFor(makeChainFlow(), "plugin")
    expect(plugin).toContain(
      "- Mode `all`: invoke the `test-sdk` skill with mode `all`, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
    )
    expect(plugin).toContain("- Mode `plugin`: stop here.")
  })

  it("emits no Next block on purely terminal steps", () => {
    const sdk = fileFor(makeChainFlow(), "sdk")
    expect(sdk).not.toContain("**Next:**")
  })

  it("prefaces multi-mode sub-skills with the dispatched-mode reminder", () => {
    const flow = makeChainFlow()
    expect(fileFor(flow, "plugin")).toContain(
      "**Mode:** you were dispatched with a mode (`all` or `plugin`);",
    )
    expect(fileFor(flow, "sdk")).toContain(
      "**Mode:** you were dispatched with a mode (`all` or `sdk`);",
    )
  })

  it("describes chain sub-skills as invoked by the flow, not the orchestrator", () => {
    const plugin = fileFor(makeChainFlow(), "plugin")
    expect(plugin).toContain("Invoked by the test flow; not run directly")
    expect(plugin).not.toContain("orchestrator")
  })

  it("adds the Skill tool to dispatching sub-skills only", () => {
    const flow = makeChainFlow()
    expect(fileFor(flow, "plugin")).toContain(
      'allowed-tools: ["Bash", "Skill"]',
    )
    expect(fileFor(flow, "sdk")).toContain('allowed-tools: ["Bash"]')
  })

  it("places appendices with the unit that references them", () => {
    const flow = makeChainFlow()
    const orchestrator = fileFor(flow, "")
    const sdk = fileFor(flow, "sdk")
    // `rep` is ref'd by sdk/parse: lives in the sdk sub-skill only.
    expect(sdk).toContain("## Reporting")
    expect(orchestrator).not.toContain("## Reporting")
    // `glob` is ref'd by nothing: stays flow-global in the orchestrator.
    expect(orchestrator).toContain("## Global")
    expect(sdk).not.toContain("## Global")
  })

  it("renders labeled dispatch lines for cross-unit branch options only", () => {
    const flow = makeChainFlow({
      entries: { all: "setup/run", plugin: "setup/run", sdk: "setup/run" },
      phases: [
        {
          id: "setup",
          title: "Setup",
          stepStyle: "list",
          steps: [
            {
              id: "run",
              kind: "branch",
              toolCalls: ["bash"],
              title: "Choose",
              body: "Pick one\n\n{{branches}}",
              branches: [
                {
                  option: { letter: "A", label: "Do the work" },
                  next: "work/do",
                },
                {
                  option: { letter: "B", label: "Skip everything" },
                  next: null,
                },
              ],
            },
          ],
        },
        {
          id: "work",
          title: "Work",
          stepStyle: "list",
          steps: [
            {
              id: "do",
              kind: "action",
              toolCalls: ["bash"],
              title: "Do",
              body: "Do it",
              next: null,
            },
          ],
        },
      ],
    })
    const orchestrator = fileFor(flow, "")
    expect(orchestrator).toContain(
      "- Option A (Do the work) (mode `all` or `plugin` or `sdk`): invoke the `test-work` skill with the current mode (`all` or `plugin` or `sdk`), forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
    )
    // Option B never dispatches; its "stop" is the body's own prose.
    expect(orchestrator).not.toContain("Option B")
    const codex = renderFlow(flow, TARGETS.codex)[0].content
    expect(codex).toContain("→ the [Work](references/work.md) reference")
    expect(codex).toContain(
      "read and follow the [Work](references/work.md) reference with the current mode",
    )
  })

  it("compiles cross-phase loops, which sequential split cannot express", () => {
    const flow = makeFlow({
      entries: { all: "iterate/work" },
      tools: { bash: { kind: "builtin", name: "Bash" } },
      compile: { mode: "split-chain", inlinePhases: [] },
      phases: [
        {
          id: "iterate",
          title: "Iterate",
          stepStyle: "list",
          steps: [
            {
              id: "work",
              kind: "action",
              toolCalls: ["bash"],
              title: "Work",
              body: "Do one round",
              next: "check/decide",
            },
          ],
        },
        {
          id: "check",
          title: "Check",
          stepStyle: "list",
          steps: [
            {
              id: "decide",
              kind: "loop",
              title: "Decide",
              body: "Evaluate the round",
              exitWhen: "all items pass",
              backTo: "iterate/work",
              onExit: "finish/done",
            },
          ],
        },
        {
          id: "finish",
          title: "Finish",
          stepStyle: "list",
          steps: [
            {
              id: "done",
              kind: "action",
              title: "Done",
              body: "Wrap up",
              next: null,
            },
          ],
        },
      ],
    })
    const files = renderFlow(flow, TARGETS.claude)
    const orchestrator = files.find((f) => f.kind === "orchestrator")?.content
    const check = files.find((f) => f.slug === "check")?.content

    // Pure dispatcher orchestrator: every mode enters a sub-phase directly.
    expect(orchestrator).toContain("## Dispatch")
    expect(orchestrator).toContain(
      "- Invoke the `test-iterate` skill, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
    )

    // The loop's two edges both dispatch; single-mode flow drops mode prose.
    expect(check).toContain(
      "- All items pass: invoke the `test-finish` skill, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
    )
    expect(check).toContain(
      "- Otherwise: invoke the `test-iterate` skill, forwarding `$ARGUMENTS` minus the leading mode keyword (if the user typed one).",
    )
    const codexCheck = renderFlow(flow, TARGETS.codex).find(
      (file) => file.slug === "check",
    )?.content
    expect(codexCheck).toContain(
      "- All items pass: read and follow the [Finish](./finish.md) reference",
    )
    expect(codexCheck).toContain(
      "- Otherwise: read and follow the [Iterate](./iterate.md) reference",
    )

    // Single-mode flow: no mode preface anywhere.
    expect(check).not.toContain("**Mode:**")
  })

  it("rejects a mode entry pointing mid-way into a non-inline phase", () => {
    expect(() =>
      makeFlow({
        entries: { all: "main/a", extra: "main/b" },
        compile: { mode: "split-chain", inlinePhases: [] },
        phases: [
          {
            id: "main",
            title: "Main",
            stepStyle: "list",
            steps: [
              {
                id: "a",
                kind: "action",
                title: "A",
                body: "A",
                next: "main/b",
              },
              { id: "b", kind: "action", title: "B", body: "B", next: null },
            ],
          },
        ],
      }),
    ).toThrow(/mid-phase/)
  })

  it("rejects sub-skill edges that re-enter an inline phase", () => {
    expect(() =>
      makeFlow({
        entries: { all: "setup/run" },
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
                body: "Run",
                next: "work/do",
              },
            ],
          },
          {
            id: "work",
            title: "Work",
            stepStyle: "list",
            steps: [
              {
                id: "do",
                kind: "action",
                title: "Do",
                body: "Do",
                next: "setup/run",
              },
            ],
          },
        ],
      }),
    ).toThrow(/re-enter the orchestrator/)
  })

  it("split (non-chain) output is unchanged by the chain machinery", () => {
    const flow = makeChainFlow({
      compile: { mode: "split", inlinePhases: ["setup"] },
    })
    const orchestrator = fileFor(flow, "")
    expect(orchestrator).toContain(
      "Invoke the `test-plugin` skill, then return here.",
    )
    expect(orchestrator).not.toContain("**Next:**")
    expect(fileFor(flow, "plugin")).not.toContain("**Mode:**")
  })

  describe("file-local {{step:...}} references", () => {
    /**
     * Step numbers are file-local: a `{{step:...}}` ref into a phase that
     * compiles to a different file would render a bare number pointing into
     * another skill - meaningless to the agent reading it. Both split modes
     * reject it; monolith (everything in one file) still allows it.
     */
    function makeCrossRefFlow(
      compile: Record<string, unknown>,
      body = "After this, run step {{step:sdk/parse}} of the SDK phase.",
    ): Flow {
      return makeChainFlow({
        compile,
        phases: [
          {
            id: "setup",
            title: "Setup",
            stepStyle: "list",
            steps: [
              {
                id: "run",
                kind: "action",
                toolCalls: ["bash"],
                title: "Run",
                body,
                next: {
                  byMode: {
                    all: "plugin/report",
                    plugin: "plugin/report",
                    sdk: "sdk/parse",
                  },
                },
              },
            ],
          },
          {
            id: "plugin",
            title: "Update plugin",
            stepStyle: "list",
            steps: [
              {
                id: "report",
                kind: "action",
                toolCalls: ["bash"],
                title: "Report",
                body: "Report the plugin result",
                next: { byMode: { all: "sdk/parse", plugin: null, sdk: null } },
              },
            ],
          },
          {
            id: "sdk",
            title: "Update SDK",
            stepStyle: "list",
            steps: [
              {
                id: "parse",
                kind: "action",
                toolCalls: ["bash"],
                title: "Parse",
                body: "Parse the status",
                next: null,
              },
            ],
          },
        ],
      })
    }

    it("rejects refs that cross a unit boundary, in both split modes", () => {
      for (const mode of ["split", "split-chain"]) {
        const flow = makeCrossRefFlow({ mode, inlinePhases: ["setup"] })
        expect(() => renderFlow(flow, TARGETS.claude)).toThrow(
          /crosses a split-unit boundary.*`test-sdk` skill by name/,
        )
      }
    })

    it("allows same-unit refs and monolith refs", () => {
      // Same unit: sdk step referencing its own phase's numbering.
      const sameUnit = makeCrossRefFlow(
        { mode: "split-chain", inlinePhases: ["setup"] },
        "Run the script.",
      )
      expect(() => renderFlow(sameUnit, TARGETS.claude)).not.toThrow()

      // Monolith: the cross-phase ref is one file, bare numbers are fine.
      // Without the continuous-numbering opt-in, numbering restarts per phase,
      // so sdk/parse is step 1 of its phase.
      const monolith = makeCrossRefFlow({ mode: "monolith" })
      const out = renderMarkdown(monolith, TARGETS.claude)
      expect(out).toContain("run step 1 of the SDK phase")
    })

    it("numbers continuously across phases when the monolith opts in", () => {
      // setup/run = 1, plugin/report = 2, sdk/parse = 3 across the three
      // phases, so the cross-phase {{step:sdk/parse}} ref resolves to 3.
      const monolith = makeCrossRefFlow({
        mode: "monolith",
        continuousStepNumbers: true,
      })
      const out = renderMarkdown(monolith, TARGETS.claude)
      expect(out).toContain("run step 3 of the SDK phase")
    })

    it("allows {{step-ref:...}} across a split-unit boundary (renders a name, not a number)", () => {
      // Unlike {{step:...}}, {{step-ref:...}} renders a stable name, so it is
      // valid across the split-unit boundary the numeric form rejects.
      for (const mode of ["split", "split-chain"]) {
        const flow = makeCrossRefFlow(
          { mode, inlinePhases: ["setup"] },
          "After this, see the {{step-ref:sdk/parse}} step.",
        )
        expect(() => renderFlow(flow, TARGETS.claude)).not.toThrow()
        const orchestrator = renderFlow(flow, TARGETS.claude).find(
          (f) => f.kind === "orchestrator",
        )
        expect(orchestrator?.content).toContain("see the Parse step")
      }
    })
  })

  describe("continuous step numbering", () => {
    function makeTwoPhaseHeaderFlow(compile: Record<string, unknown>): Flow {
      return makeFlow({
        compile,
        entries: { all: "first/alpha" },
        phases: [
          {
            id: "first",
            title: "First",
            stepStyle: "headers",
            steps: [
              {
                id: "alpha",
                kind: "action",
                title: "Alpha",
                body: "Do alpha.",
                next: "second/beta",
              },
            ],
          },
          {
            id: "second",
            title: "Second",
            stepStyle: "headers",
            steps: [
              {
                id: "beta",
                kind: "action",
                title: "Beta",
                body: "Do beta.",
                next: null,
              },
            ],
          },
        ],
      })
    }

    it("restarts headers per phase by default (mode-gated alternatives)", () => {
      const out = renderMarkdown(
        makeTwoPhaseHeaderFlow({ mode: "monolith" }),
        TARGETS.claude,
      )
      expect(out).toContain("## 1. Alpha")
      expect(out).toContain("## 1. Beta")
    })

    it("numbers headers continuously across phases when opted in", () => {
      const out = renderMarkdown(
        makeTwoPhaseHeaderFlow({
          mode: "monolith",
          continuousStepNumbers: true,
        }),
        TARGETS.claude,
      )
      expect(out).toContain("## 1. Alpha")
      expect(out).toContain("## 2. Beta")
      // No duplicate `## 1.` header once numbering is continuous.
      expect(out).not.toContain("## 1. Beta")
    })
  })
})

describe("Renderer: branch destinations and placeholder indentation", () => {
  it("appends step-number destinations to {{branches}} option lines", () => {
    const flow = makeFlow({
      entries: { all: "main/pick" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "pick",
              kind: "branch",
              title: "Pick",
              body: "{{branches}}",
              branches: [
                {
                  option: { letter: "A", label: "Do it" },
                  recommended: true,
                  next: "main/work",
                },
                { option: { letter: "B", label: "Skip" }, next: null },
              ],
            },
            {
              id: "work",
              kind: "action",
              title: "Work",
              body: "Work body",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("> A) **Do it** *(recommended)* → step 2")
    expect(out).toContain("> B) **Skip** → stop")
  })

  it("groups byMode option destinations per target with mode lists", () => {
    const flow = makeFlow({
      entries: { all: "main/pick", quick: "main/pick" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "pick",
              kind: "branch",
              title: "Pick",
              body: "{{branches}}",
              branches: [
                {
                  option: { letter: "A", label: "Continue" },
                  next: { byMode: { all: "main/work", quick: null } },
                },
                { option: { letter: "B", label: "Bail" }, next: null },
              ],
            },
            {
              id: "work",
              kind: "action",
              title: "Work",
              body: "Work body",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain(
      "> A) **Continue** → step 2 (mode `all`); stop (mode `quick`)",
    )
  })

  it("renders cross-unit option destinations as skill names under split modes", () => {
    const flow = makeFlow({
      entries: { all: "main/pick" },
      compile: { mode: "split-chain", inlinePhases: ["main"] },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "pick",
              kind: "branch",
              title: "Pick",
              body: "{{branches}}",
              branches: [
                {
                  option: { letter: "A", label: "Do the work" },
                  next: "work/do",
                },
                { option: { letter: "B", label: "Skip" }, next: null },
              ],
            },
          ],
        },
        {
          id: "work",
          title: "Work",
          stepStyle: "headers",
          steps: [
            {
              id: "do",
              kind: "action",
              title: "Do",
              body: "Do body",
              next: null,
            },
          ],
        },
      ],
    })
    const orchestrator = renderFlow(flow, TARGETS.claude).find(
      (f) => f.kind === "orchestrator",
    )?.content
    // No bare step number leaks across the file boundary.
    expect(orchestrator).toContain(
      "> A) **Do the work** → the `test-work` skill",
    )
    expect(orchestrator).toContain("> B) **Skip** → stop")
  })

  it("appends destinations to {{whens}} lines, skipping redundant stops", () => {
    const flow = makeFlow({
      entries: { all: "main/decide" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "decide",
              kind: "branch",
              title: "Decide",
              body: "{{whens}}",
              branches: [
                { when: "it failed", description: "stop the flow", next: null },
                { when: "it worked", next: "main/done" },
              ],
            },
            {
              id: "done",
              kind: "action",
              title: "Done",
              body: "End",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain("- **it failed**: stop the flow\n")
    expect(out).toContain("- **it worked**: continue → step 2")
  })

  it("indents {{list:...}} continuation lines to match the placeholder's line", () => {
    const flow = makeFlow({
      entries: { all: "main/scan" },
      tables: {
        sdks: {
          rows: [
            {
              key: "typescript",
              label: "TypeScript",
              cells: { imports: "`import acme`" },
            },
            {
              key: "python",
              label: "Python",
              cells: { imports: "`import acme`" },
            },
          ],
        },
      },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "list",
          steps: [
            {
              id: "scan",
              kind: "action",
              title: "Scan",
              body: "- Grep for imports:\n  {{list:sdks:imports}}\n- Then proceed.",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    // List body indent is 3 spaces plus the placeholder's own 2. The first line
    // keeps the placeholder's prefix in place; the continuation line must be
    // re-indented to match, not dedent to column 0.
    expect(out).toContain("     - TypeScript: `import acme`")
    expect(out).toContain("     - Python: `import acme`")
    expect(out).not.toContain("\n- Python")
  })
})

describe("Renderer: branch destination qualification and mode grouping", () => {
  it("qualifies same-file destinations in another phase with the phase title", () => {
    const flow = makeFlow({
      entries: { all: "main/pick" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "pick",
              kind: "branch",
              title: "Pick",
              body: "{{branches}}",
              branches: [
                {
                  option: { letter: "A", label: "Wrap up" },
                  next: "finish/done",
                },
                { option: { letter: "B", label: "Bail" }, next: null },
              ],
            },
          ],
        },
        {
          id: "finish",
          title: "Finish",
          stepStyle: "headers",
          steps: [
            {
              id: "done",
              kind: "action",
              title: "Done",
              body: "End",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    // "step 1" alone would be ambiguous: numbering restarts per phase.
    expect(out).toContain("> A) **Wrap up** → step 1 of the Finish phase")
  })

  it("collapses the largest byMode group to 'otherwise'", () => {
    const flow = makeFlow({
      entries: { all: "main/pick", quick: "main/pick", deep: "main/pick" },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            {
              id: "pick",
              kind: "branch",
              title: "Pick",
              body: "{{branches}}",
              branches: [
                {
                  option: { letter: "A", label: "Continue" },
                  next: {
                    byMode: { all: "main/work", quick: null, deep: null },
                  },
                },
                { option: { letter: "B", label: "Bail" }, next: null },
              ],
            },
            {
              id: "work",
              kind: "action",
              title: "Work",
              body: "Work body",
              next: null,
            },
          ],
        },
      ],
    })
    const out = renderMarkdown(flow, TARGETS.claude)
    expect(out).toContain(
      "> A) **Continue** → step 2 (mode `all`); otherwise stop",
    )
  })
})

describe("Renderer: Modes dispatch block", () => {
  function multiModeFlow(overrides: Record<string, unknown> = {}): Flow {
    return makeFlow({
      entries: {
        default: "main/a",
        build: "build/b",
        help: "help/h",
      },
      defaultMode: "default",
      // Opt into the Modes block. `build` intentionally has no hint so the
      // phase-title fallback stays under test.
      modeHints: { default: "The default landing." },
      phases: [
        {
          id: "main",
          title: "Main",
          stepStyle: "headers",
          steps: [
            { id: "a", kind: "action", title: "A", body: "Body A", next: null },
          ],
        },
        {
          id: "build",
          title: "Build",
          stepStyle: "headers",
          steps: [
            { id: "b", kind: "action", title: "B", body: "Body B", next: null },
          ],
        },
        {
          id: "help",
          title: "Help",
          stepStyle: "headers",
          steps: [
            { id: "h", kind: "action", title: "H", body: "Body H", next: null },
          ],
        },
      ],
      ...overrides,
    })
  }

  it("emits a Modes table with $ARGUMENTS routing for multi-mode flows", () => {
    const out = renderMarkdown(multiModeFlow(), TARGETS.claude)
    expect(out).toContain("## Modes")
    expect(out).toContain("Read `$ARGUMENTS` first.")
    expect(out).toContain("run `default` and treat `$ARGUMENTS` as its input")
    expect(out).toContain("| Mode | Trigger | What it does |")
  })

  it("falls through to the default mode when the first token isn't a mode", () => {
    // Content-first flows (scope, PR id, provider, bare key) must not read the
    // first arg as a mode selector.
    const out = renderMarkdown(multiModeFlow(), TARGETS.claude)
    expect(out).toContain(
      "If its first token is exactly one of the mode names below",
    )
    expect(out).toContain("treat `$ARGUMENTS` as its input")
  })

  it("defers to the flow's own routing prose before defaulting", () => {
    // The fallback is flow-shape aware: setup/assistant document their own NL
    // argument routing, so the generated sentence hands off to that prose
    // instead of claiming non-mode input always lands on the default mode.
    const out = renderMarkdown(multiModeFlow(), TARGETS.claude)
    expect(out).toContain(
      "when this skill documents how to route the remaining arguments",
    )
  })

  it("uses the monolith routing sentence (sections inline, not dispatched)", () => {
    const out = renderMarkdown(multiModeFlow(), TARGETS.claude)
    expect(out).toContain(
      "Run only that mode's section below and skip the others.",
    )
    expect(out).not.toContain("Follow only the selected mode's path below.")
  })

  it("renders defaultMode's trigger as (no argument) and others as their name", () => {
    const out = renderMarkdown(multiModeFlow(), TARGETS.claude)
    expect(out).toContain("| `default` | (no argument) |")
    expect(out).toContain("| `build` | `build` |")
    expect(out).toContain("| `help` | `help` |")
  })

  it("uses modeHints for descriptions when present", () => {
    const out = renderMarkdown(
      multiModeFlow({
        modeHints: { build: "Compile the thing." },
      }),
      TARGETS.claude,
    )
    expect(out).toContain("| `build` | `build` | Compile the thing. |")
  })

  it("falls back to the entry phase title when a mode has no hint", () => {
    const out = renderMarkdown(multiModeFlow(), TARGETS.claude)
    // `build` has no hint, so it falls back to the "Build" phase title.
    expect(out).toContain("| `build` | `build` | Build |")
  })

  it("resolves per-target modeHints", () => {
    const out = renderMarkdown(
      multiModeFlow({
        modeHints: {
          build: {
            claude: "Claude build.",
            cursor: "Cursor build.",
            amp: "Amp build.",
            codex: "Codex build.",
          },
        },
      }),
      TARGETS.codex,
    )
    expect(out).toContain("Codex build.")
    expect(out).not.toContain("Claude build.")
  })

  it("emits no Modes block for single-mode flows", () => {
    const out = renderMarkdown(makeFlow(), TARGETS.claude)
    expect(out).not.toContain("## Modes")
  })

  it("emits no Modes block for a multi-mode flow that declares no modeHints", () => {
    // Opt-in gate: without modeHints the block never renders, so multi-mode
    // flows that route their own way (e.g. user-facing setup/update/assistant)
    // stay byte-identical.
    const out = renderMarkdown(multiModeFlow({ modeHints: {} }), TARGETS.claude)
    expect(out).not.toContain("## Modes")
  })
})

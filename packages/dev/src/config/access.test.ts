import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { type Probe, probeAccess, systemProbe } from "./access.ts"
import { findIssue } from "./adapters/linear.ts"
import { fillOps, resolveCapability } from "./integrations.ts"
import { github } from "./sections/github.ts"

function fakeProbe(
  bins: Record<string, boolean>,
  env: Record<string, string> = {},
): Probe {
  return {
    which: (bin) => (bin in bins ? `/bin/${bin}` : undefined),
    succeeds: async ([bin]) => bins[bin] === true,
    env,
  }
}

describe("probeAccess", () => {
  it("reports a signed-in CLI, a set token, and the MCP server to look for", async () => {
    expect(
      await probeAccess(
        github.access,
        fakeProbe({ gh: true }, { GH_TOKEN: "x" }),
      ),
    ).toEqual({
      mcp: { server: "GitHub" },
      cli: { bin: "gh", installed: true, ready: true, auth: "gh auth status" },
      api: {
        base: "https://api.github.com",
        source: "env GH_TOKEN",
        configured: false,
        expression: "$GH_TOKEN",
        ready: true,
      },
    })
  })

  it("tells an installed but signed-out CLI from a missing one", async () => {
    const signedOut = await probeAccess(github.access, fakeProbe({ gh: false }))
    expect(signedOut.cli).toMatchObject({ installed: true, ready: false })
    const missing = await probeAccess(github.access, fakeProbe({}))
    expect(missing.cli).toMatchObject({ installed: false, ready: false })
    expect(missing.api).toMatchObject({
      source: "env GITHUB_TOKEN",
      ready: false,
    })
  })

  it("needs no sign-in check for a CLI without one", async () => {
    const report = await probeAccess(
      { cli: { bin: "gt" } },
      fakeProbe({ gt: false }),
    )
    expect(report.cli).toEqual({ bin: "gt", installed: true, ready: true })
  })

  it("finds executables on PATH and runs the sign-in check", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-probe-"))
    try {
      const bin = path.join(dir, "fakecli")
      fs.writeFileSync(bin, '#!/bin/sh\n[ "$1" = ok ]\n', { mode: 0o755 })
      const probe = systemProbe({ PATH: dir })
      expect(probe.which("fakecli")).toBe(bin)
      expect(probe.which("absent")).toBeUndefined()
      expect(await probe.succeeds([bin, "ok"])).toBe(true)
      expect(await probe.succeeds([bin, "no"])).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("variant order", () => {
  it("puts an adapter's script variant first, then the op's own order", () => {
    const { configured } = resolveCapability(
      { integrations: { linear: { teamKey: "ENG" } } },
      "issueTracker",
      undefined,
      {},
      {
        "integrations.linear": {
          findIssue: { adapter: findIssue, source: "plugin" },
        },
      },
    )
    const op = configured[0].ops.findIssue as Record<string, string>
    expect(Object.keys(op)).toEqual(["script", "mcp"])
    expect(op.script).toContain(
      'adapter.ts" run linear findIssue --line <line>` (built-in adapter)',
    )
    expect(op.script).toContain("`access.api.ready`")
  })
})

describe("fillOps", () => {
  it("fills every variant, and the token as its shell expression", () => {
    const ops = fillOps(
      github.provides.sourceControl,
      { owner: "acme", repo: "web" },
      "$GH_TOKEN",
    )
    expect(ops.prDiff).toEqual({
      mcp: expect.stringContaining("acme/web #<N>"),
      cli: "`gh pr diff <N> --repo acme/web`",
      api: expect.stringContaining(
        '-H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github.diff" "https://api.github.com/repos/acme/web/pulls/<N>"',
      ),
    })
    expect(ops.prRef).toBe(
      "A bare number, or `https://github.com/acme/web/pull/<N>`",
    )
  })
})

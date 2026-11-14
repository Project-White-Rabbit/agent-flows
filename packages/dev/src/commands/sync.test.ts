import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  BLOCK_END,
  BLOCK_START,
  type BranchState,
  branchFile,
  capText,
  gate,
  issueDescription,
  LAST_SYNCED,
  lastSyncedLine,
  migrateState,
  parsePr,
  protectedBranchesOf,
  protectedRefusal,
  readBranchState,
  readLegacyState,
  readLinearIdFile,
  resolveAdopted,
  spliceBlock,
  syncFormat,
  syncStamp,
  withoutAdopted,
  withoutLegacySync,
  workState,
  writeBranchState,
} from "./sync.ts"

const clean = {
  mode: "default" as const,
  onBase: false,
  dirty: false,
  ahead: 2,
  behind: 0,
  unpushed: 0,
  head: "abc",
  pr: parsePr("12:open:true"),
}

const synced: BranchState = {
  remote: { head: "abc", pr: "12:open:true", linkedRefs: [] },
}

describe("gate", () => {
  it("is a no-op when nothing changed since the last sync", () => {
    expect(gate({ ...clean, stored: synced })).toEqual({
      runLocal: false,
      runRemote: false,
      noop: true,
      newErrorRefs: [],
    })
  })

  it("runs local work for a dirty tree, a moved base, or unpushed commits", () => {
    for (const change of [
      { dirty: true },
      { behind: 1 },
      { unpushed: 1 },
      { unpushed: undefined },
      { onBase: true },
    ]) {
      expect(gate({ ...clean, ...change, stored: synced }).runLocal).toBe(true)
    }
  })

  it("doesn't count a moved base as local work with --no-catch-up", () => {
    const behind = { ...clean, behind: 3, stored: synced }
    expect(gate({ ...behind, catchUp: false }).runLocal).toBe(false)
    expect(gate({ ...behind, catchUp: false, dirty: true }).runLocal).toBe(true)
    expect(gate(behind).runLocal).toBe(true)
  })

  it("follows local work with remote writes in default mode only", () => {
    const dirty = { ...clean, dirty: true, stored: synced }
    expect(gate(dirty).runRemote).toBe(true)
    expect(gate({ ...dirty, mode: "local" }).runRemote).toBe(false)
  })

  it("never pushes in local mode, so unpushed commits don't count", () => {
    expect(
      gate({ ...clean, mode: "local", unpushed: 3, stored: synced }).noop,
    ).toBe(true)
  })

  it("runs remote writes when the PR or HEAD moved, or a ref is unlinked", () => {
    expect(
      gate({ ...clean, pr: parsePr("12:open:false"), stored: synced }),
    ).toMatchObject({ runRemote: true, runLocal: false })
    expect(gate({ ...clean, head: "def", stored: synced }).runRemote).toBe(true)
    expect(gate({ ...clean, pr: undefined, stored: synced }).runRemote).toBe(
      true,
    )
    const refs = gate({
      ...clean,
      stored: { ...synced, errorRefs: ["WEB-1", "WEB-2"] },
    })
    expect(refs).toMatchObject({
      runRemote: true,
      newErrorRefs: ["WEB-1", "WEB-2"],
    })
  })

  it("never runs local work in remote mode", () => {
    expect(
      gate({
        ...clean,
        mode: "remote",
        dirty: true,
        behind: 4,
        stored: synced,
      }),
    ).toMatchObject({ runLocal: false, noop: true })
  })
})

describe("workState", () => {
  it("derives the issue state from the PR and the branch", () => {
    expect(workState(parsePr("1:merged:false"), 3)).toBe("done")
    expect(workState(parsePr("1:closed:false"), 3)).toBe("canceled")
    expect(workState(undefined, 0)).toBe("todo")
    expect(workState(undefined, 2)).toBe("in progress")
    expect(workState(parsePr("1:open:true"), 2)).toBe("in progress")
    expect(workState(parsePr("1:open:false"), 2)).toBe("in review")
  })
})

describe("parsePr", () => {
  it("reads none and number:state:draft, and rejects anything else", () => {
    expect(parsePr("none")).toBeUndefined()
    expect(parsePr("7:OPEN:true")).toEqual({
      number: "7",
      state: "open",
      draft: true,
    })
    expect(() => parsePr("7:open")).toThrow(/--pr must be/)
  })
})

describe("spliceBlock", () => {
  it("puts the block on top of a body without one, keeping the body", () => {
    expect(spliceBlock("Notes from a human.\n", "## Summary\n\n- x")).toBe(
      `${BLOCK_START}\n## Summary\n\n- x\n${BLOCK_END}\n\nNotes from a human.\n`,
    )
    expect(spliceBlock("", "## Summary")).toBe(
      `${BLOCK_START}\n## Summary\n${BLOCK_END}\n`,
    )
  })

  it("replaces only its own block on a re-run", () => {
    const first = spliceBlock("Above\n\nBelow", "old")
    const edited = `Intro\n\n${first}\n\nAdded later`
    const second = spliceBlock(edited, `${BLOCK_START}\nnew\n${BLOCK_END}`)
    expect(second).toContain("Intro")
    expect(second).toContain("Added later")
    expect(second).toContain("new")
    expect(second).not.toContain("old")
    expect(second.split(BLOCK_START)).toHaveLength(2)
  })
})

describe("spliceBlock over an earlier sync tool's body", () => {
  const legacy = [
    "> Linear: [ENG-1: Fix login](https://l/ENG-1)",
    "> Sentry: Fixes WEB-4P ([WEB-4P](https://s/WEB-4P))",
    "> Lore: [Session](https://lore/t/1)",
    "",
    "## Summary",
    "",
    "- Fixes login",
    "",
    "**Before:** it failed. **After:** it works.",
    "",
    "## Test plan",
    "",
    "- [ ] Log in",
    "",
    "_Last synced: 2026-10-20 10:00 UTC (HEAD: abc1234)_",
  ].join("\n")

  it("replaces its link lines, Summary, Test plan, and last-synced line", () => {
    const out = spliceBlock(legacy, "## Summary\n\n- new")
    expect(out).toBe(`${BLOCK_START}\n## Summary\n\n- new\n${BLOCK_END}\n`)
  })

  it("keeps what a person added around them", () => {
    const body = `${legacy}\n\nThanks for reviewing!\n\n## Screenshots\n\n![x](y)`
    const out = withoutLegacySync(body)
    expect(out).toContain("Thanks for reviewing!")
    expect(out).toContain("## Screenshots\n\n![x](y)")
    expect(out).not.toContain("Summary")
    expect(out).not.toContain("> Lore:")
  })

  it("leaves a body no sync tool wrote alone", () => {
    const body = "> Note: read this first\n\n## Summary\n\nMine."
    expect(withoutLegacySync(body)).toBe(body)
  })
})

describe("spliceBlock over an adopted tool's body", () => {
  const adopted = [
    "Linear: https://linear.app/acme/issue/HEY-12",
    "",
    "## Summary",
    "",
    "- Old summary",
    "",
    "## Verification",
    "",
    "- ran it",
    "",
    "## Screenshots",
    "",
    "![x](y)",
  ].join("\n")
  const block =
    "Linear: [HEY-12](https://l/HEY-12) Title\n\n## Summary\n\n- new\n\n## Verification\n\n- checked"

  it("replaces its header and the sections sync writes, keeping the rest", () => {
    const out = spliceBlock(adopted, block, { adoptHeader: "^Linear\\s*:" })
    expect(out.match(/## Summary/g)).toHaveLength(1)
    expect(out.match(/Linear:/g)).toHaveLength(1)
    expect(out).not.toContain("Old summary")
    expect(out).not.toContain("ran it")
    expect(out).toContain("## Screenshots\n\n![x](y)")
    expect(out.startsWith(BLOCK_START)).toBe(true)
  })

  it("does the same without markers", () => {
    const out = spliceBlock(adopted, block, {
      markers: false,
      adoptHeader: "^Linear\\s*:",
    })
    expect(out).toBe(`${block}\n\n## Screenshots\n\n![x](y)\n`)
  })

  it("leaves a body that doesn't start with the header alone", () => {
    const body = "Notes first\n\nLinear: x\n\n## Summary\n\nMine."
    expect(
      withoutAdopted(body, { header: /^Linear\s*:/, sections: ["Summary"] }),
    ).toBe(body)
  })

  it("adds its block above an adopted body without the header setting", () => {
    expect(spliceBlock(adopted, block)).toContain("Old summary")
  })
})

describe("capText", () => {
  it("cuts long text and says so", () => {
    expect(capText("abc", 5)).toBe("abc")
    expect(capText("abcdef", 3)).toBe("abc\n[cut at 3 characters]")
  })
})

describe("syncFormat", () => {
  it("is sync's own format when the config leaves it out", () => {
    const own = {
      linkLabels: "capability",
      errorVerb: null,
      prTitle: null,
      blockMarkers: true,
      quoteLinks: true,
      prSections: null,
      prLinkLine: true,
      noIssueLine: null,
      footer: true,
      adoptHeader: null,
      linkStyle: "link",
    }
    expect(syncFormat(undefined)).toEqual(own)
    expect(syncFormat({ version: 2 })).toEqual(own)
  })

  it("reads what the config's sync section sets", () => {
    const sync = {
      linkLabels: "integration",
      errorVerb: "Fixes",
      prTitle: "{issueId}: {title}",
      blockMarkers: false,
      quoteLinks: false,
      prSections: ["Summary", "Verification"],
      prLinkLine: false,
      noIssueLine: "none",
      footer: true,
      adoptHeader: "^Linear\\s*:",
      linkStyle: "url",
    }
    expect(syncFormat({ sync })).toEqual(sync)
  })

  it("keeps the last-synced line without markers, where it bounds the block", () => {
    expect(
      syncFormat({ sync: { footer: false, blockMarkers: false } }).footer,
    ).toBe(true)
    expect(syncFormat({ sync: { footer: false } }).footer).toBe(false)
  })

  it("ignores an adoptHeader that isn't a regex", () => {
    expect(syncFormat({ sync: { adoptHeader: "(" } }).adoptHeader).toBeNull()
  })

  it("keeps the format a branch was written in, under what the config sets", () => {
    const recorded = {
      linkLabels: "integration" as const,
      errorVerb: "Fixes",
      prTitle: null,
      blockMarkers: false,
      quoteLinks: true,
      prSections: null,
      prLinkLine: true,
      noIssueLine: null,
      footer: true,
      adoptHeader: null,
      linkStyle: "link" as const,
    }
    expect(syncFormat(undefined, recorded)).toEqual(recorded)
    expect(
      syncFormat(
        { sync: { blockMarkers: true, prTitle: "{title}" } },
        recorded,
      ),
    ).toEqual({ ...recorded, blockMarkers: true, prTitle: "{title}" })
  })

  it("reads a format recorded before quoteLinks and prSections with their defaults", () => {
    expect(
      syncFormat(undefined, {
        linkLabels: "integration",
        errorVerb: "Fixes",
        prTitle: null,
        blockMarkers: false,
      }),
    ).toMatchObject({ quoteLinks: true, prSections: null, linkStyle: "link" })
  })
})

describe("branch state files", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  const tmp = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-state-"))
    return dir
  }

  it("keeps one file per branch, slashes and all", () => {
    const states = tmp()
    writeBranchState(states, "me/fix-login", { issue: "ENG-1" }, () => true)
    expect(fs.readdirSync(states)).toEqual(["me%2Ffix-login.json"])
    expect(readBranchState(states, "me/fix-login")).toEqual({ issue: "ENG-1" })
    expect(readBranchState(states, "other")).toBeUndefined()
  })

  it("forgets branches that no longer exist", () => {
    const states = tmp()
    writeBranchState(states, "gone", { issue: "ENG-1" }, () => true)
    writeBranchState(states, "kept", { issue: "ENG-2" }, (b) => b === "kept")
    expect(fs.readdirSync(states)).toEqual(["kept.json"])
  })

  it("moves the old per-worktree file in, keeping newer shared state", () => {
    const root = tmp()
    const old = path.join(root, "sync.json")
    const states = path.join(root, "sync")
    writeBranchState(states, "a", { issue: "NEW-1" }, () => true)
    fs.writeFileSync(
      old,
      JSON.stringify({
        branches: { a: { issue: "OLD-1" }, "me/b": { issue: "OLD-2" } },
      }),
    )
    migrateState(old, states)
    expect(fs.existsSync(old)).toBe(false)
    expect(readBranchState(states, "a")).toEqual({ issue: "NEW-1" })
    expect(readBranchState(states, "me/b")).toEqual({ issue: "OLD-2" })
    expect(fs.existsSync(branchFile(states, "me/b"))).toBe(true)
  })
})

describe("spliceBlock without markers", () => {
  const stamp = "_Last synced: 2026-10-24 10:00 UTC (HEAD: abc1234)_"
  // What bitfab-dev's sync writes, and what this one writes in its format.
  const theirs = [
    "> Linear: [ENG-1: Fix login](https://l/ENG-1)",
    "> Sentry: Fixes WEB-4P ([WEB-4P](https://s/WEB-4P))",
    "> Lore: [Session](https://lore/t/1)",
    "",
    "## Summary",
    "",
    "- Old summary",
    "",
    "## Test plan",
    "",
    "- [ ] Old check",
    "",
    "_Last synced: 2026-10-20 10:00 UTC (HEAD: 0000000)_",
  ].join("\n")
  const ours = [
    "> Linear: [ENG-1](https://l/ENG-1) Fix login",
    "> Sentry: Fixes WEB-4P ([WEB-4P](https://s/WEB-4P))",
    "> Lore: [Session](https://lore/t/2)",
    "",
    "Fixes ENG-1",
    "",
    "## Summary",
    "",
    "- New summary",
    "",
    "## Test plan",
    "",
    "- [ ] New check",
    "",
    stamp,
  ].join("\n")
  const splice = (body: string, block = ours) =>
    spliceBlock(body, block, { markers: false })
  /** The `> ` link lines, the way bitfab-dev's sync finds its own. */
  const links = (body: string) =>
    body.split("\n").filter((line) => /^> \w+:/.test(line))
  // What bitfab-dev's sync keeps of a body when it refreshes only its links.
  const theirStrip = (body: string) =>
    body
      .split("\n")
      .filter(
        (line) =>
          !/^> (?:Linear|Branch|Sentry|Lore|Planning):/.test(line) &&
          !/^_Last synced:.*_$/.test(line.trim()),
      )
      .join("\n")

  it("writes the block on top with no markers", () => {
    expect(splice("")).toBe(`${ours}\n`)
    expect(splice("Notes from a human.")).toBe(
      `${ours}\n\nNotes from a human.\n`,
    )
  })

  it("replaces a body bitfab-dev's sync wrote, keeping a person's notes", () => {
    const out = splice(`${theirs}\n\nThanks for reviewing!`)
    expect(out).toBe(`${ours}\n\nThanks for reviewing!\n`)
  })

  it("replaces its own block on a re-run, nothing twice", () => {
    const first = splice(`${theirs}\n\nThanks for reviewing!`)
    const second = splice(first, ours.replace("New summary", "Newer summary"))
    expect(second).toContain("Newer summary")
    expect(second).not.toContain("- New summary")
    expect(second.match(/Fixes ENG-1$/gm)).toHaveLength(1)
    expect(links(second)).toEqual(links(ours))
    expect(second.match(/_Last synced/g)).toHaveLength(1)
    expect(second).toContain("Thanks for reviewing!")
  })

  it("takes turns with bitfab-dev's sync without duplicating lines", () => {
    const mine = splice(theirs)
    // bitfab-dev's link-only refresh: its lines on top, the rest kept.
    const refreshed = `${links(theirs).join("\n")}\n\n${theirStrip(mine).trim()}\n\n${stamp}\n`
    expect(links(refreshed)).toEqual(links(theirs))
    const again = splice(refreshed)
    expect(again).toBe(`${ours}\n`)
  })

  it("replaces capability-labeled lines with integration-labeled ones", () => {
    const old = spliceBlock(
      "",
      "> Issue: [ENG-1](https://l/ENG-1) Fix login\n> Errors: WEB-4P ([WEB-4P](https://s/WEB-4P))\n\n## Summary\n\n- x\n\n" +
        stamp,
      { markers: false },
    )
    const out = splice(old)
    expect(out).toBe(`${ours}\n`)
    expect(out).not.toMatch(/^> (Issue|Errors):/m)
  })

  it("unwraps a block written with markers before", () => {
    const marked = spliceBlock("Thanks for reviewing!", ours)
    const out = splice(marked)
    expect(out).not.toContain(BLOCK_START)
    expect(out).not.toContain(BLOCK_END)
    expect(out).toBe(`${ours}\n\nThanks for reviewing!\n`)
  })

  it("drops a marked block bitfab-dev's sync left next to its own lines", () => {
    const marked = spliceBlock("", ours.replace(/^> Linear:/m, "> Issue:"))
    const refreshed = `${links(theirs).join("\n")}\n\n${theirStrip(marked).trim()}\n\n${stamp}\n`
    expect(splice(refreshed)).toBe(`${ours}\n`)
  })

  it("replaces the sections of the repo's PR template it wrote", () => {
    const block = `> Linear: [ENG-1: x](https://l/ENG-1)\n\n## What\n\n- a\n\n## Testing\n\n- b\n\n${stamp}`
    const first = splice("## Screenshots\n\n![x](y)", block)
    const second = splice(first, block.replace("- a", "- c"))
    expect(second.match(/## What/g)).toHaveLength(1)
    expect(second).toContain("- c")
    expect(second).not.toContain("- a")
    expect(second).toContain("## Screenshots\n\n![x](y)")
  })
})

describe("readLegacyState", () => {
  let root: string | undefined
  afterEach(() => {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  function write(file: string, value: unknown): string {
    root ??= fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-legacy-"))
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), JSON.stringify(value))
    return root
  }

  it("reads the issue and error refs left for this branch", () => {
    const dir = write(".bitfab-dev/state.json", {
      linearId: "ENG-9",
      branch: "feature",
      sentryRefs: [
        { id: "WEB-4P", title: "WEB-4P", url: "https://s/WEB-4P" },
        { title: "x", url: "https://s/issues/123" },
      ],
    })
    expect(readLegacyState(dir, "feature")).toEqual({
      issue: "ENG-9",
      errorRefs: ["WEB-4P", "https://s/issues/123"],
    })
    expect(readLegacyState(dir, "other")).toBeUndefined()
  })

  it("falls back to the older file, and tolerates junk", () => {
    const dir = write(".bitfab-sync/state.json", {
      linearId: "ENG-3",
      branch: "feature",
    })
    expect(readLegacyState(dir, "feature")).toEqual({
      issue: "ENG-3",
      errorRefs: [],
    })
    write(".bitfab-dev/state.json", "not an object")
    expect(readLegacyState(dir, "feature")).toEqual({
      issue: "ENG-3",
      errorRefs: [],
    })
  })

  function writeText(file: string, text: string): string {
    root ??= fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-legacy-"))
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
    return root
  }

  it("reads the oldest linear-id file: the id, then the branch it's for", () => {
    const dir = writeText(".bitfab-sync/linear-id", "eng-12\nfeature\n")
    expect(readLinearIdFile(dir, "feature")).toBe("ENG-12")
    expect(readLegacyState(dir, "feature")).toEqual({
      issue: "ENG-12",
      errorRefs: [],
    })
    expect(readLegacyState(dir, "other")).toBeUndefined()
    // One line names no branch, so it counts for any.
    writeText(".bitfab-sync/linear-id", "ENG-13\n")
    expect(readLinearIdFile(dir, "other")).toBe("ENG-13")
    writeText(".bitfab-sync/linear-id", "\n")
    expect(readLinearIdFile(dir, "other")).toBeUndefined()
  })

  it("reads the linear-id file only when no state file is there", () => {
    const dir = writeText(".bitfab-sync/linear-id", "ENG-12\n")
    write(".bitfab-dev/state.json", { linearId: "ENG-9", branch: "other" })
    expect(readLegacyState(dir, "feature")).toBeUndefined()
  })
})

describe("readLegacyState with adopted files", () => {
  let root: string | undefined
  afterEach(() => {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("reads an adopted tool's file from a git dir, by issueId or linearId", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-adopt-"))
    const gitDir = path.join(root, "gitdir")
    fs.mkdirSync(path.join(gitDir, "tool"), { recursive: true })
    fs.writeFileSync(
      path.join(gitDir, "tool", "state.json"),
      JSON.stringify({ branch: "feature", linearId: "HEY-3" }),
    )
    fs.writeFileSync(
      path.join(root, "other.json"),
      JSON.stringify({ branch: "feature", issueId: "ENG-4" }),
    )
    const adopt = { files: ["{gitDir}/tool/state.json"], gitDir }
    expect(readLegacyState(root, "feature", adopt)).toEqual({
      issue: "HEY-3",
      errorRefs: [],
      adopted: true,
    })
    expect(readLegacyState(root, "other", adopt)).toBeUndefined()
    expect(
      readLegacyState(root, "feature", { files: ["other.json"] }),
    ).toMatchObject({ issue: "ENG-4", adopted: true })
  })

  it("prefers bitfab-dev's file for the branch, and falls back to adopted ones", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-adopt-"))
    fs.mkdirSync(path.join(root, ".bitfab-dev"))
    fs.writeFileSync(
      path.join(root, ".bitfab-dev", "state.json"),
      JSON.stringify({ branch: "elsewhere", linearId: "ENG-1" }),
    )
    fs.writeFileSync(
      path.join(root, "t.json"),
      JSON.stringify({ branch: "feature", linearId: "HEY-5" }),
    )
    expect(
      readLegacyState(root, "feature", { files: ["t.json"] }),
    ).toMatchObject({ issue: "HEY-5", adopted: true })
    expect(readLegacyState(root, "elsewhere", { files: ["t.json"] })).toEqual({
      issue: "ENG-1",
      errorRefs: [],
    })
  })

  it("resolves placeholders, and skips one with no value", () => {
    expect(
      resolveAdopted("/r", "{gitCommonDir}/x.json", { gitCommonDir: "/g" }),
    ).toBe("/g/x.json")
    expect(resolveAdopted("/r", "a/x.json", {})).toBe("/r/a/x.json")
    expect(resolveAdopted("/r", "{gitDir}/x.json", {})).toBeUndefined()
  })
})

describe("lastSyncedLine", () => {
  it("stamps the time and the short HEAD", () => {
    expect(
      lastSyncedLine("0123456789abcdef", new Date("2026-10-23T20:41:09Z")),
    ).toBe("_Last synced: 2026-10-23 20:41 UTC (HEAD: 0123456)_")
  })

  it("stamps it in sync.timezone, by the zone's short name", () => {
    const at = new Date("2026-10-23T20:41:09Z")
    expect(lastSyncedLine("0123456789", at, "America/Los_Angeles")).toBe(
      "_Last synced: 2026-10-23 13:41 PT (HEAD: 0123456)_",
    )
    expect(syncStamp(at, "Europe/Berlin")).toBe("2026-10-23 22:41 GMT+2")
    expect(syncStamp(new Date("2026-10-23T23:30:00Z"), "Asia/Tokyo")).toBe(
      "2026-10-24 08:30 GMT+9",
    )
    expect(syncStamp(at, "UTC")).toBe("2026-10-23 20:41 UTC")
    expect(syncStamp(at, "Not/AZone")).toBe("2026-10-23 20:41 UTC")
  })
})

describe("protected branches", () => {
  const config = {
    repo: { baseBranch: "dev", protectedBranches: ["main", "dev"] },
  }

  it("refuses on a protected branch, never on the base", () => {
    expect(protectedBranchesOf(config, "dev")).toEqual(["main"])
    expect(protectedRefusal("main", "dev", config)).toMatch(
      /^Refusing to sync on main: it's protected \(repo\.protectedBranches\)/,
    )
    expect(protectedRefusal("dev", "dev", config)).toBeUndefined()
    expect(protectedRefusal("feature", "dev", config)).toBeUndefined()
  })

  it("protects nothing the config doesn't list", () => {
    expect(protectedBranchesOf(undefined, "main")).toEqual([])
    expect(
      protectedBranchesOf({ repo: { baseBranch: "main" } }, "main"),
    ).toEqual([])
    expect(protectedRefusal("main", "dev", { repo: {} })).toBeUndefined()
  })
})

// Each test here runs sync.ts and git as real processes, a dozen or more per
// test, which a busy CI runner can push past vitest's 5s default.
describe("sync.ts (as a script)", { timeout: 30_000 }, () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  const script = path.join(import.meta.dirname, "sync.ts")
  const work = () => path.join(dir as string, "work")
  const sync = (args: string[]) =>
    spawnSync("node", [script, ...args], { cwd: work(), encoding: "utf8" })
  const json = (args: string[]) => {
    const result = sync(args)
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    return JSON.parse(result.stdout)
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", work(), ...args], { encoding: "utf8" })

  function init(): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-flows-sync-"))
    const origin = path.join(dir, "origin.git")
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin])
    execFileSync("git", ["clone", "-q", origin, work()], { stdio: "ignore" })
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    git("commit", "-q", "--allow-empty", "-m", "Init")
    git("push", "-q", "origin", "HEAD:main")
    git("switch", "-q", "-c", "feature")
  }

  it("prints the issue a sync recorded for the branch, without writing", () => {
    init()
    expect(json(["issue"])).toEqual({ branch: "feature", issue: null })
    json(["finish", "--base", "main", "--pr", "none", "--issue", "ENG-7"])
    expect(json(["issue"])).toEqual({ branch: "feature", issue: "ENG-7" })
  })

  it("gates on what changed since finish recorded the last sync", () => {
    init()
    const survey = ["survey", "default", "--base", "main", "--pr", "none"]
    expect(json(survey)).toMatchObject({
      branch: "feature",
      baseRef: "origin/main",
      ahead: 0,
      behind: 0,
      runLocal: false,
      runRemote: true,
    })

    fs.writeFileSync(path.join(work(), "a.txt"), "a")
    expect(json(survey)).toMatchObject({ dirty: true, runLocal: true })

    git("add", "-A")
    git("commit", "-q", "-m", "Add a")
    git("push", "-q", "-u", "origin", "HEAD")
    const pr = ["--pr", "5:open:true"]
    expect(
      json(["finish", "--base", "main", ...pr, "--remote", "--issue", "ENG-1"]),
    ).toMatchObject({ written: true, branch: "feature" })

    const again = json(["survey", "default", "--base", "main", ...pr])
    expect(again).toMatchObject({
      ahead: 1,
      unpushed: 0,
      issue: "ENG-1",
      noop: true,
    })
    expect(json(["facts", "--base", "main", ...pr])).toMatchObject({
      workState: "in progress",
      updateKind: "metadata-only",
    })

    // A new error ref reopens the remote writes until a remote sync links it.
    expect(
      json([
        "survey",
        "remote",
        "--base",
        "main",
        ...pr,
        "--error-ref",
        "WEB-1",
      ]),
    ).toMatchObject({ newErrorRefs: ["WEB-1"], runRemote: true })
    json([
      "finish",
      "--base",
      "main",
      ...pr,
      "--remote",
      "--linked-ref",
      "WEB-1",
    ])
    expect(json(["survey", "remote", "--base", "main", ...pr])).toMatchObject({
      errorRefs: ["WEB-1"],
      newErrorRefs: [],
      noop: true,
    })

    // A dropped issue is forgotten.
    json(["finish", "--base", "main", ...pr, "--issue", "none"])
    expect(json(["survey", "remote", "--base", "main", ...pr]).issue).toBeNull()

    // The PR becoming ready is a remote change only.
    expect(
      json(["survey", "default", "--base", "main", "--pr", "5:open:false"]),
    ).toMatchObject({ runLocal: false, runRemote: true })
  })

  it("starts a branch from an earlier sync tool's state, once", () => {
    init()
    fs.mkdirSync(path.join(work(), ".bitfab-dev"))
    fs.writeFileSync(
      path.join(work(), ".bitfab-dev", "state.json"),
      JSON.stringify({
        linearId: "ENG-9",
        branch: "feature",
        sentryRefs: [{ id: "WEB-4P", url: "https://s/WEB-4P" }],
      }),
    )
    git("commit", "-q", "--allow-empty", "-m", "Work")
    const survey = ["survey", "remote", "--base", "main", "--pr", "none"]
    expect(json(survey)).toMatchObject({
      issue: "ENG-9",
      errorRefs: ["WEB-4P"],
      newErrorRefs: ["WEB-4P"],
      // Its sync wrote this branch's PR, so sync keeps that tool's format.
      format: { linkLabels: "integration", blockMarkers: false },
    })
    // A dropped issue stays dropped, though the old file still names it.
    json(["finish", "--base", "main", "--pr", "none", "--issue", "none"])
    expect(json(survey).issue).toBeNull()
  })

  it("starts a branch from an adopted tool's state, in the config's format", () => {
    init()
    const gitDir = git("rev-parse", "--absolute-git-dir").trim()
    fs.mkdirSync(path.join(gitDir, "tool"))
    fs.writeFileSync(
      path.join(gitDir, "tool", "state.json"),
      JSON.stringify({ branch: "feature", linearId: "HEY-9" }),
    )
    fs.mkdirSync(path.join(work(), ".agent-flows"))
    fs.writeFileSync(
      path.join(work(), ".agent-flows", "config.json"),
      JSON.stringify({
        version: 2,
        repo: { baseBranch: "main" },
        sync: { adoptState: ["{gitDir}/tool/state.json"], quoteLinks: false },
      }),
    )
    const survey = ["survey", "remote", "--base", "main", "--pr", "none"]
    const out = json(survey)
    expect(out.issue).toBe("HEY-9")
    // Not bitfab-dev's format: the config says how this repo writes.
    expect(out.format).toMatchObject({
      linkLabels: "capability",
      blockMarkers: true,
      quoteLinks: false,
    })
  })

  it("refuses on a protected branch, and leaves a moved base alone with --no-catch-up", () => {
    init()
    fs.mkdirSync(path.join(work(), ".agent-flows"))
    fs.writeFileSync(
      path.join(work(), ".agent-flows", "config.json"),
      JSON.stringify({
        version: 3,
        repo: { baseBranch: "main", protectedBranches: ["prod"] },
      }),
    )
    git("switch", "-q", "-c", "prod")
    const refused = sync([
      "survey",
      "default",
      "--base",
      "main",
      "--pr",
      "none",
    ])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/Refusing to sync on prod/)

    git("switch", "-q", "feature")
    git("switch", "-q", "main")
    git("commit", "-q", "--allow-empty", "-m", "Base moved")
    git("push", "-q", "origin", "HEAD:main")
    git("switch", "-q", "feature")
    git("add", "-A")
    git("commit", "-q", "-m", "Config")
    git("push", "-q", "-u", "origin", "HEAD")
    const survey = ["survey", "default", "--base", "main", "--pr", "none"]
    expect(json(survey)).toMatchObject({ behind: 1, runLocal: true })
    expect(json([...survey, "--no-catch-up"])).toMatchObject({
      behind: 1,
      catchUp: false,
      runLocal: false,
    })
  })

  it("stops when origin has no base branch to compare against", () => {
    init()
    const result = sync(["survey", "default", "--base", "dev", "--pr", "none"])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/origin\/dev doesn't exist/)
    const facts = sync(["facts", "--base", "dev", "--pr", "none"])
    expect(facts.status).toBe(1)
  })

  it("doesn't count commits as pushed once origin deleted the branch", () => {
    init()
    git("commit", "-q", "--allow-empty", "-m", "Work")
    git("push", "-q", "-u", "origin", "HEAD")
    const survey = ["survey", "default", "--base", "main", "--pr", "none"]
    expect(json(survey).unpushed).toBe(0)
    // Deleted on the host: the local remote-tracking ref is now stale.
    execFileSync("git", [
      "--git-dir",
      path.join(dir as string, "origin.git"),
      "branch",
      "-q",
      "-D",
      "feature",
    ])
    expect(
      git("rev-parse", "--verify", "-q", "origin/feature").trim(),
    ).not.toBe("")
    expect(json(survey)).toMatchObject({ unpushed: null, runLocal: true })
  })

  it("gives commit bodies in facts when the config asks", () => {
    init()
    git("commit", "-q", "--allow-empty", "-m", "Add x\n\nVerification: ran it")
    const facts = ["facts", "--base", "main", "--pr", "none"]
    expect(json(facts).commits).not.toContain("Verification")
    fs.mkdirSync(path.join(work(), ".agent-flows"))
    fs.writeFileSync(
      path.join(work(), ".agent-flows", "config.json"),
      JSON.stringify({
        version: 2,
        repo: { baseBranch: "main" },
        sync: { commitBodies: true },
      }),
    )
    const commits = json(facts).commits
    expect(commits).toMatch(/^commit [0-9a-f]+\nAdd x\n\nVerification: ran it/)
  })

  it("keeps its state out of the working tree", () => {
    init()
    json(["finish", "--base", "main", "--pr", "none"])
    expect(git("status", "--porcelain")).toBe("")
  })

  it("refuses a detached HEAD", () => {
    init()
    git("checkout", "-q", "--detach")
    const result = sync(["survey", "default", "--base", "main", "--pr", "none"])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/detached/)
  })

  it("splices a block into a body file", () => {
    init()
    const body = path.join(dir as string, "body.md")
    const block = path.join(dir as string, "block.md")
    fs.writeFileSync(body, "Human notes")
    fs.writeFileSync(block, "## Summary")
    const result = sync(["splice", "--body", body, "--block", block])
    expect(result.stdout).toBe(
      `${BLOCK_START}\n## Summary\n${BLOCK_END}\n\nHuman notes\n`,
    )
  })

  it("reads the repo's sync format from its config, and records it", () => {
    init()
    const format = {
      linkLabels: "integration",
      errorVerb: "Fixes",
      prTitle: "{issueId}: {title}",
      blockMarkers: false,
      quoteLinks: false,
      prSections: ["Summary", "Verification"],
      prLinkLine: false,
      noIssueLine: "none",
      footer: true,
      adoptHeader: "^Linear\\s*:",
      linkStyle: "url",
    }
    fs.mkdirSync(path.join(work(), ".agent-flows"))
    fs.writeFileSync(
      path.join(work(), ".agent-flows", "config.json"),
      JSON.stringify({
        version: 2,
        repo: { baseBranch: "main" },
        sync: format,
      }),
    )
    const survey = ["survey", "remote", "--base", "main", "--pr", "none"]
    expect(json(survey).format).toEqual(format)
    // The branch keeps the format it was written in once the config drops it.
    json(["finish", "--base", "main", "--pr", "none", "--remote"])
    fs.rmSync(path.join(work(), ".agent-flows"), { recursive: true })
    expect(json(survey).format).toEqual(format)
  })

  it("splices without markers when asked", () => {
    init()
    const body = path.join(dir as string, "body.md")
    const block = path.join(dir as string, "block.md")
    fs.writeFileSync(body, "Human notes")
    fs.writeFileSync(block, "## Summary")
    const args = ["splice", "--body", body, "--block", block, "--no-markers"]
    expect(sync(args).stdout).toBe("## Summary\n\nHuman notes\n")
  })

  it("shares a branch's state with the worktree that checks it out next", () => {
    init()
    json(["finish", "--base", "main", "--pr", "none", "--issue", "ENG-1"])
    git("switch", "-q", "main")
    const other = path.join(dir as string, "other")
    git("worktree", "add", "-q", other, "feature")
    const result = spawnSync(
      "node",
      [script, "survey", "local", "--base", "main", "--pr", "none"],
      { cwd: other, encoding: "utf8" },
    )
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).issue).toBe("ENG-1")
  })

  it("moves a worktree's old state file into the shared dir", () => {
    init()
    const gitDir = git("rev-parse", "--absolute-git-dir").trim()
    fs.mkdirSync(path.join(gitDir, "agent-flows"))
    fs.writeFileSync(
      path.join(gitDir, "agent-flows", "sync.json"),
      JSON.stringify({ branches: { feature: { issue: "ENG-7" } } }),
    )
    expect(
      json(["survey", "local", "--base", "main", "--pr", "none"]).issue,
    ).toBe("ENG-7")
    expect(fs.existsSync(path.join(gitDir, "agent-flows", "sync.json"))).toBe(
      false,
    )
  })
})

describe("issue description", () => {
  const doc =
    "https://linear.app/acme/document/planning-week-of-2026-11-02-1a2b3c"
  const lore = "https://lore.test/t/abc"
  const now = "_Last synced: 2026-11-04 10:00 UTC (HEAD: abc1234)_"
  // What Linear stores, and what its MCP's get_issue shows for it.
  const stored = [
    "> Branch: `eng-1-fix-login`",
    `> Lore: [Session](${lore})`,
    `> Planning: [Planning, week of 2026-11-02](${doc}), from [Sync](https://n/p)`,
    "",
    "## Description",
    "",
    "Fix the login redirect.",
    "",
    "## Status",
    "",
    "**Done:**",
    "",
    "- The redirect",
    "",
  ]
  const mcpRead = [
    ...stored.slice(0, 2),
    `> Planning: <document id="d1" label="Planning, week of 2026-11-02" href="${doc}" />, from [Sync](https://n/p)`,
    ...stored.slice(3),
    "*Last synced: 2026-11-01 09:00 UTC (HEAD: 0000000)*",
  ].join("\n")

  it("finds the last-synced line in sync's emphasis and Linear's", () => {
    expect(LAST_SYNCED.test(now)).toBe(true)
    expect(LAST_SYNCED.test(now.replaceAll("_", "*"))).toBe(true)
    expect(LAST_SYNCED.test(`_${now.slice(1, -1)}*`)).toBe(false)
  })

  it("replaces a PR body's old marker when it's stored with asterisks", () => {
    const body = [
      "> Issue: [ENG-1](https://t/1)",
      "",
      "## Summary",
      "",
      "- Old",
      "",
      "*Last synced: 2026-11-01 09:00 UTC (HEAD: 0000000)*",
    ].join("\n")
    const block = `> Issue: [ENG-1](https://t/1)\n\n## Summary\n\n- New\n\n${now}`
    const out = spliceBlock(body, block, { markers: false })
    expect(out.match(/Last synced/g)).toHaveLength(1)
    expect(out).not.toContain("- Old")
  })

  it("gives back the lines Linear stores, byte for byte, with one marker", () => {
    // Sync's compose: the MCP's read, with this sync's marker ending Status.
    const composed = `${mcpRead}\n${now}\n`
    const out = issueDescription(composed, now)
    expect(out).toBe(`${stored.join("\n")}\n${now}\n`)
    expect(out.split("\n").slice(0, 3)).toEqual(stored.slice(0, 3))
    expect(issueDescription(out, now)).toBe(out)
  })

  it("keeps the old marker when this sync's isn't in the file", () => {
    expect(issueDescription(mcpRead, now)).toContain("*Last synced: 2026-11-01")
    expect(issueDescription(mcpRead)).toContain("*Last synced: 2026-11-01")
  })

  it("readies the file in place from the command line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-description-"))
    try {
      const file = path.join(dir, "issue-new.md")
      fs.writeFileSync(file, `${mcpRead}\n${now}\n`)
      const script = path.join(import.meta.dirname, "sync.ts")
      const run = () =>
        spawnSync(
          "node",
          [script, "description", "--file", file, "--last-synced", now],
          { encoding: "utf8" },
        )
      expect(run().stdout.trim()).toBe(`CHANGED ${file}`)
      expect(fs.readFileSync(file, "utf8")).toBe(
        `${stored.join("\n")}\n${now}\n`,
      )
      expect(run().stdout.trim()).toBe("UNCHANGED")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

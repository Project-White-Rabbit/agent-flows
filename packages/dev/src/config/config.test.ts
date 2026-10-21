import { describe, expect, it } from "vitest"
import {
  applyPatch,
  checkConfig,
  checkPatch,
  migrate,
  normalize,
  planConfig,
  resolveSections,
  serializeConfig,
} from "./config.ts"
import type { SectionSpec } from "./types.ts"

// A small registry so these tests pin the generic behavior, not today's
// sections.
const REGISTRY: SectionSpec[] = [
  {
    path: "repo",
    name: "Repository",
    purpose: "",
    required: true,
    fields: [
      { key: "baseBranch", description: "", example: "main", required: true },
      { key: "protected", description: "", example: true, type: "boolean" },
    ],
  },
  {
    path: "services.alpha",
    name: "Alpha",
    purpose: "",
    fields: [
      { key: "id", description: "", example: "a1", required: true },
      { key: "tags", description: "", example: ["x"], type: "string[]" },
    ],
  },
  {
    path: "services.beta",
    name: "Beta",
    purpose: "",
    fields: [{ key: "id", description: "", example: "b1", required: true }],
  },
]

const base = { version: 1, repo: { baseBranch: "main" } }

describe("checkConfig", () => {
  it("accepts a minimal valid config", () => {
    expect(checkConfig(base, REGISTRY)).toEqual({ issues: [], warnings: [] })
  })

  it("errors on known fields with the wrong type or missing", () => {
    expect(
      checkConfig(
        {
          version: 1,
          repo: { protected: "yes" },
          services: { alpha: { tags: "x" } },
        },
        REGISTRY,
      ).issues,
    ).toEqual([
      "repo.protected must be true or false",
      "repo.baseBranch is required",
      "services.alpha.tags must be a list of non-empty strings",
      "services.alpha.id is required",
    ])
  })

  it("requires required sections", () => {
    expect(checkConfig({ version: 1 }, REGISTRY).issues).toEqual([
      "repo is required",
    ])
  })

  it("only warns about what a newer plugin may have written", () => {
    const { issues, warnings } = checkConfig(
      {
        ...base,
        repo: { baseBranch: "main", mergeQueue: true },
        services: { gamma: { id: "g" } },
        hooks: {},
        skipped: ["services.delta"],
      },
      REGISTRY,
    )
    expect(issues).toEqual([])
    expect(warnings).toEqual([
      expect.stringContaining('unknown key "hooks"'),
      expect.stringContaining('unknown section "services.gamma"'),
      expect.stringContaining('unknown field "repo.mergeQueue"'),
      expect.stringContaining('skipped lists unknown section "services.delta"'),
    ])
  })

  it("rejects skipping a required or configured section", () => {
    expect(
      checkConfig(
        {
          ...base,
          services: { alpha: { id: "a" } },
          skipped: ["repo", "services.alpha"],
        },
        REGISTRY,
      ).issues,
    ).toEqual([
      "repo is required and can't be skipped",
      "services.alpha is both configured and skipped",
    ])
  })
})

describe("migrate", () => {
  const migrations = [
    {
      from: 1,
      migrate: (c: Record<string, unknown>) => ({ ...c, renamed: c.old }),
    },
  ]

  it("upgrades older configs step by step", () => {
    expect(migrate({ version: 1, old: "x" }, migrations, 2)).toEqual({
      config: { version: 2, old: "x", renamed: "x" },
      issues: [],
    })
  })

  it("rejects a config from a newer plugin instead of misreading it", () => {
    expect(migrate({ version: 3 }, migrations, 2).issues).toEqual([
      expect.stringContaining("upgrade the agent-flows plugin"),
    ])
  })

  it("needs a version", () => {
    expect(migrate({}, [], 1).issues).toEqual([
      "version is required (current: 1)",
    ])
  })
})

describe("checkPatch", () => {
  it("only lets writes touch known sections, and never skip required ones", () => {
    expect(
      checkPatch(
        { sections: { "services.gamma": { id: "g" } }, skip: ["repo"] },
        REGISTRY,
      ),
    ).toEqual([
      expect.stringContaining('unknown section "services.gamma"'),
      "repo is required and can't be skipped",
    ])
  })
})

describe("applyPatch", () => {
  it("replaces given sections, removes nulls, and keeps everything else", () => {
    const next = applyPatch(
      {
        ...base,
        services: { beta: { id: "b" }, gamma: { id: "g" } },
        hooks: { pre: "x" },
      },
      {
        sections: {
          "services.alpha": { id: "a" },
          "services.beta": null,
        },
      },
      REGISTRY,
    )
    expect(next).toEqual({
      version: 1,
      repo: { baseBranch: "main" },
      services: { alpha: { id: "a" }, gamma: { id: "g" } },
      hooks: { pre: "x" },
    })
  })

  it("skips sections, and configuring one un-skips it", () => {
    const skipped = applyPatch(
      { ...base, services: { alpha: { id: "a" } } },
      { skip: ["services.alpha", "services.beta"] },
      REGISTRY,
    )
    expect(skipped).toEqual({
      ...base,
      skipped: ["services.alpha", "services.beta"],
    })
    expect(
      applyPatch(
        skipped,
        { sections: { "services.beta": { id: "b" } } },
        REGISTRY,
      ),
    ).toEqual({
      ...base,
      services: { beta: { id: "b" } },
      skipped: ["services.alpha"],
    })
  })

  it("is byte-stable: the same content in any order serializes identically", () => {
    const a = applyPatch(
      undefined,
      {
        sections: {
          "services.beta": { id: "b" },
          "services.alpha": { tags: ["x"], id: "a" },
          repo: { protected: false, baseBranch: "main" },
        },
        skip: [],
      },
      REGISTRY,
    )
    const b = applyPatch(
      a,
      { sections: { "services.alpha": { id: "a", tags: ["x"] } } },
      REGISTRY,
    )
    expect(serializeConfig(b)).toBe(serializeConfig(a))
    expect(serializeConfig(a)).toBe(`{
  "version": 1,
  "repo": {
    "baseBranch": "main",
    "protected": false
  },
  "services": {
    "alpha": {
      "id": "a",
      "tags": [
        "x"
      ]
    },
    "beta": {
      "id": "b"
    }
  }
}
`)
  })
})

describe("normalize", () => {
  it("orders known keys by the registry, unknown keys after, skipped last", () => {
    const out = normalize(
      {
        skipped: ["services.beta"],
        zeta: 1,
        services: { gamma: {}, alpha: { tags: [], id: "a" } },
        repo: { baseBranch: "main" },
        version: 1,
      },
      REGISTRY,
    )
    expect(Object.keys(out)).toEqual([
      "version",
      "repo",
      "services",
      "zeta",
      "skipped",
    ])
    expect(Object.keys(out.services as object)).toEqual(["alpha", "gamma"])
    expect(Object.keys((out.services as { alpha: object }).alpha)).toEqual([
      "id",
      "tags",
    ])
  })
})

describe("planConfig", () => {
  const detected = {
    "services.alpha": { values: { id: "a" }, evidence: ["clue"] },
    "services.beta": { values: {}, evidence: ["depends on beta"] },
  }

  it("proposes detected and required sections and flags missing fields", () => {
    const plan = planConfig(undefined, detected, REGISTRY)
    expect(plan.upToDate).toBe(false)
    expect(plan.changes.map((c) => [c.section, c.kind])).toEqual([
      ["repo", "add"],
      ["services.alpha", "add"],
      ["services.beta", "add"],
    ])
    expect(plan.needs).toEqual([
      { section: "repo", fields: ["baseBranch"] },
      { section: "services.beta", fields: ["id"] },
    ])
  })

  it("plans nothing once the config covers or skips everything detected", () => {
    const config = applyPatch(
      undefined,
      {
        sections: {
          repo: { baseBranch: "main" },
          "services.alpha": { id: "a" },
        },
        skip: ["services.beta"],
      },
      REGISTRY,
    )
    expect(planConfig(config, detected, REGISTRY)).toEqual({
      upToDate: true,
      changes: [],
      needs: [],
      conflicts: [],
    })
  })

  it("fills empty fields but never overwrites configured values", () => {
    const plan = planConfig(
      {
        ...base,
        services: { alpha: { id: "renamed" } },
        skipped: ["services.beta"],
      },
      {
        ...detected,
        "services.alpha": { values: { id: "a", tags: ["t"] }, evidence: [] },
      },
      REGISTRY,
    )
    expect(plan.changes).toEqual([
      expect.objectContaining({
        section: "services.alpha",
        kind: "fill",
        field: "tags",
        value: ["t"],
      }),
    ])
    expect(plan.conflicts).toEqual([
      {
        section: "services.alpha",
        field: "id",
        configured: "renamed",
        detected: "a",
      },
    ])
  })
})

describe("resolveSections", () => {
  it("accepts full paths or their last segment, once each", () => {
    expect(
      resolveSections(["alpha", "services.alpha", "repo", "gamma"], REGISTRY),
    ).toEqual({ paths: ["services.alpha", "repo"], unknown: ["gamma"] })
  })
})

describe("planConfig with only", () => {
  it("plans just the named sections, including skipped and undetected ones", () => {
    const config = {
      ...base,
      services: { alpha: { id: "a" } },
      skipped: ["services.beta"],
    }
    const plan = planConfig(config, {}, REGISTRY, ["services.beta"])
    expect(plan.changes).toEqual([
      {
        section: "services.beta",
        kind: "add",
        values: {},
        evidence: ["requested"],
      },
    ])
    expect(plan.needs).toEqual([{ section: "services.beta", fields: ["id"] }])
  })

  it("is up to date when a named section is already complete", () => {
    const config = { ...base, services: { alpha: { id: "a" } } }
    expect(planConfig(config, {}, REGISTRY, ["services.alpha"]).upToDate).toBe(
      true,
    )
  })

  it("also plans required sections the config still lacks", () => {
    const plan = planConfig(
      undefined,
      { repo: { values: { baseBranch: "main" }, evidence: ["origin/HEAD"] } },
      REGISTRY,
      ["services.beta"],
    )
    expect(plan.changes.map((c) => c.section)).toEqual([
      "repo",
      "services.beta",
    ])
  })
})

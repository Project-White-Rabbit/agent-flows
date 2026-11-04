import type { SectionSpec } from "../types.ts"

export const repo: SectionSpec = {
  path: "repo",
  name: "Repository",
  purpose: "The branch work merges into, for diffs, reviews, and PRs",
  required: true,
  fields: [
    {
      key: "baseBranch",
      description: "Branch feature work merges into",
      example: "main",
      required: true,
    },
    {
      key: "protectedBranches",
      type: "string[]",
      description:
        "Branches besides the base that no flow works on directly, such as a production branch the base is promoted to: sync, ready, merge, and close refuse on them",
      example: ["main"],
      pattern: {
        regex: /^[^\s~^:?*[\\]+$/,
        hint: "branch names (`main`, `release/prod`)",
      },
    },
  ],
  lookup:
    "`git symbolic-ref --short refs/remotes/origin/HEAD`, or ask. Set `protectedBranches` only when the agent instructions name a branch work must never land on directly (a production branch the base is promoted to)",
  detect(ctx) {
    const head = ctx.git([
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ])
    if (head) {
      return {
        values: { baseBranch: head.replace(/^origin\//, "") },
        evidence: [`origin/HEAD is ${head}`],
      }
    }
    for (const candidate of ["main", "master"]) {
      if (
        ctx.git(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])
      ) {
        return {
          values: { baseBranch: candidate },
          evidence: [`local branch ${candidate} exists`],
        }
      }
    }
    return undefined
  },
}

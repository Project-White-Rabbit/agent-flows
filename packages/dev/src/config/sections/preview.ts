import {
  packageScripts,
  resolveScript,
  runnerFor,
  scriptCommand,
  unsafeCommand,
} from "../scripts.ts"
import type {
  DetectContext,
  Detection,
  FieldPattern,
  SectionSpec,
} from "../types.ts"

/** A local web address: `http://localhost:3000`, with an optional path. */
const LOCAL_URL: FieldPattern = {
  regex: /^https?:\/\/[\w.-]+(:\d{1,5})?(\/[\w./%~-]*)?$/,
  hint: "a URL like `http://localhost:3000`",
}

/** Script names that start a dev server, most likely first. */
const DEV_SCRIPTS = ["dev", "start:dev", "serve", "start"]

/**
 * The root script that starts the dev server: the first of `DEV_SCRIPTS` that
 * runs nothing unsafe. `start` only when it isn't a production server
 * (`next start`, `node dist/…`), which wouldn't reload the branch's edits.
 */
export function detectPreview(ctx: DetectContext): Detection | undefined {
  const scripts = packageScripts(ctx, "")
  const runner = runnerFor(ctx, "")
  for (const name of DEV_SCRIPTS) {
    const body = scripts[name]
    if (body === undefined) {
      continue
    }
    if (unsafeCommand(resolveScript(ctx, "", body))) {
      continue
    }
    if (
      name === "start" &&
      /\bnext start\b|\bnode\s+(dist|build)\b/.test(body)
    ) {
      continue
    }
    return {
      values: { command: scriptCommand(runner, "", name) },
      evidence: [`package.json has a ${name} script (\`${body}\`)`],
    }
  }
  return undefined
}

export const preview: SectionSpec = {
  path: "preview",
  name: "Preview",
  purpose:
    "How preview starts the repo's dev server and where it serves, so it can open what a branch changed in a browser",
  fields: [
    {
      key: "command",
      description:
        "Command that starts the dev server from the repo root and keeps it running. Preview runs it in the background when this checkout has no server running, its output in a log in the worktree's git dir, and waits until it answers",
      example: "bun run dev",
    },
    {
      key: "url",
      description:
        "Where the dev server serves, when it's always the same. Leave it unset when each worktree gets its own port: preview reads the URL the server prints, or the port this checkout's server listens on. When it's set and another checkout's server holds it, preview says so rather than open the other checkout's work",
      example: "http://localhost:3000",
      pattern: LOCAL_URL,
    },
    {
      key: "timeout",
      type: "number",
      description:
        "Seconds preview waits for a server it started to answer (default 120). It goes on running past that",
      example: 180,
    },
  ],
  detect: detectPreview,
  lookup:
    "Leave it out when the repo has no web app to preview. Detection proposes `command` from a root `dev` (else `start:dev`, `serve`, or a `start` that isn't a production server) script. Set it by hand for a monorepo whose app has its own (`bun run --cwd apps/web dev`), and set `url` when the server always serves the same address and prints none",
}

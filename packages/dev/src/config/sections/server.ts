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
export function detectServer(ctx: DetectContext): Detection | undefined {
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

export const server: SectionSpec = {
  path: "server",
  name: "Dev server",
  purpose:
    "How the repo's dev server starts and where it serves, so dev-flows can start one for a worktree (for preview, or on its own), and stop it once nothing needs it",
  fields: [
    {
      key: "command",
      description:
        "Command that starts the dev server from the repo root and keeps it running. Dev-flows runs it in the background when this checkout has no server running, its output in a log in the repo's git dir, and waits until it answers",
      example: "bun run dev",
    },
    {
      key: "url",
      description:
        "Where the dev server serves, when it's always the same for everyone (the port the repo's dev script fixes, not one you picked on your machine). Leave it unset when each worktree gets its own port: dev-flows reads the URL the server prints, or the port this checkout's server listens on. When it's set and another checkout's server holds it, dev-flows says so rather than use the other checkout's server",
      example: "http://localhost:3000",
      pattern: LOCAL_URL,
    },
    {
      key: "timeout",
      type: "number",
      description:
        "Seconds dev-flows waits for a server it started to answer (default 120). It goes on running past that",
      example: 180,
    },
    {
      key: "idleTimeout",
      type: "number",
      description:
        "Minutes a server dev-flows started may go with nothing connected to it (no page open on it) before it's stopped (default 240; 0: never). One is also stopped once its worktree is deleted, whatever this says",
      example: 60,
    },
  ],
  detect: detectServer,
  lookup:
    "Leave it out when the repo has no dev server (a library, a CLI). Detection proposes `command` from a root `dev` (else `start:dev`, `serve`, or a `start` that isn't a production server) script. Set it by hand for a monorepo whose app has its own (`bun run --cwd apps/web dev`), and set `url` when the server always serves the same address and prints none",
}

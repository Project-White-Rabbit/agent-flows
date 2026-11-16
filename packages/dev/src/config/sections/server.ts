import { hookField } from "../hooks.ts"
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

/** A port range, `3001-3099`, or one port. */
const PORT_RANGE: FieldPattern = {
  regex: /^\d{1,5}(-\d{1,5})?$/,
  hint: "a range of ports like `3001-3099`",
}

/** What a manager command (`server.up` and friends) gets, for its description. */
const MANAGER_PLACEHOLDERS =
  "Runs from the repo root, with the branch as `$BRANCH` and `{branch}`, the worktree's path as `$WORKTREE` and `{worktree}` (each shell-quoted), and, with `ports`, the worktree's port as `$PORT` and `{port}`"

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
    "How the repo's dev server starts and where it serves, so the commands can start one for a worktree (for preview, or on its own), and stop it once nothing needs it",
  fields: [
    {
      key: "command",
      description:
        "Command that starts the dev server from the repo root and keeps it running. Dev-flows runs it in the background when this checkout has no server running, its output in a log in the repo's git dir, and waits until it answers. Set `up` instead when a manager of the repo's own runs its servers",
      example: "bun run dev",
    },
    {
      key: "url",
      description:
        "Where the dev server serves, when it's always the same for everyone (the port the repo's dev script fixes, not one you picked on your machine). Leave it unset when each worktree gets its own port: the flows read the URL the server prints, or the port this checkout's server listens on. When it's set and another checkout's server holds it, the flows say so rather than use the other checkout's server",
      example: "http://localhost:3000",
      pattern: LOCAL_URL,
    },
    {
      key: "timeout",
      type: "number",
      description:
        "Seconds the commands wait for a server it started to answer (default 120). It goes on running past that",
      example: 180,
    },
    {
      key: "idleTimeout",
      type: "number",
      description:
        "Minutes a server the commands started may go with nothing connected to it (no page open on it) before it's stopped (default 240; 0: never). One is also stopped once its worktree is deleted, whatever this says. Not for a server `up` starts: its manager decides",
      example: 60,
    },
    {
      key: "ports",
      description:
        "A range of ports (`3001-3099`) to give each worktree's server its own: the commands pick one nothing listens on, keeps the same one for a worktree while it's free, and passes it to `command` as `$PORT` and `{port}`. The server's URL is then `url` on that port (`http://localhost:<port>` with no `url`). Leave it unset when the repo's dev script picks its own port",
      example: "3001-3099",
      pattern: PORT_RANGE,
    },
    {
      key: "up",
      description: `For a repo whose dev servers a manager of its own runs (a daemon, a process manager, a script that starts servers in the background): the command that starts this worktree's server through it and returns once it's started, set instead of \`command\`. Dev-flows then runs no watchdog and stops nothing on its own: the manager owns the server, and \`down\` stops it. The URL comes from \`status\`, else the first URL \`up\` prints, else \`url\` (on the \`ports\` port). ${MANAGER_PLACEHOLDERS}`,
      example: "dsm up -p bitfab",
      alternativeTo: "command",
    },
    {
      key: "down",
      description: `With \`up\`: the command that stops this worktree's server through the manager (\`/<plugin>:server stop\`, and finish and cancel once the work is over). ${MANAGER_PLACEHOLDERS}`,
      example: "dsm down -p bitfab",
      needs: "up",
    },
    {
      key: "restart",
      description: `With \`up\`: the command that restarts this worktree's server through the manager (default: \`down\`, then \`up\`). ${MANAGER_PLACEHOLDERS}`,
      example: "dsm restart -p bitfab",
      needs: "up",
    },
    {
      key: "status",
      description: `With \`up\`: a command that prints this worktree's server URL and exits 0 while it runs, and exits non-zero (or prints no URL) when it doesn't, so a running server is found without starting it again. Without it, \`up\` runs every time (fine for a manager whose \`up\` leaves a running server as it is). ${MANAGER_PLACEHOLDERS}`,
      example:
        "node -e 'console.log(require(\"./.bitfab/config.local.json\").serviceUrl)'",
      needs: "up",
    },
    {
      key: "list",
      description: `With \`up\`: a command that lists the servers the manager runs across the repo's worktrees, shown as it prints it (\`/<plugin>:server list\`). ${MANAGER_PLACEHOLDERS}`,
      example: "dsm ls",
      needs: "up",
    },
    hookField("server.started"),
    hookField("server.stopped"),
  ],
  detect: detectServer,
  lookup:
    "Leave it out when the repo has no dev server (a library, a CLI). Detection proposes `command` from a root `dev` (else `start:dev`, `serve`, or a `start` that isn't a production server) script. Set it by hand for a monorepo whose app has its own (`bun run --cwd apps/web dev`), and set `url` when the server always serves the same address and prints none. When the repo's instructions start servers through a manager of their own (a command that starts them in the background and returns, with commands to stop and list them), set `up`, `down`, and the others it has instead of `command`",
}

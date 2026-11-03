// Shapes for fields that end up inside commands. An op pastes config values
// into a command the agent runs, and the config is committed, so any field an
// op uses must have one of these: none of them admits a shell metacharacter.

import type { FieldPattern } from "../types.ts"

/** An account, org, or repository name: `acme`, `web.app`. */
export const SLUG: FieldPattern = {
  regex: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  hint: "letters, digits, `.`, `_`, or `-`",
}

/** A slash-separated path of slugs: `acme/platform/web`. */
export const SLUG_PATH: FieldPattern = {
  regex: /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/,
  hint: "slash-separated names of letters, digits, `.`, `_`, or `-` (`group/project`)",
}

/** An issue key prefix: `ENG`, `WEB2`. */
export const ISSUE_KEY: FieldPattern = {
  regex: /^[A-Za-z][A-Za-z0-9_]*$/,
  hint: "a letter, then letters, digits, or `_` (`ENG`)",
}

/** A host name with an optional port: `gitlab.acme.dev:8443`. */
export const HOST: FieldPattern = {
  regex:
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/,
  hint: "a lowercase host name, with an optional `:port` (`gitlab.acme.dev`)",
}

/** Who can open a shared link: `private`, `workspace`, or `public`. */
export const VISIBILITY: FieldPattern = {
  regex: /^(private|workspace|public)$/,
  hint: "`private`, `workspace`, or `public`",
}

/** A GitHub Actions workflow's file name: `claude.yml`. */
export const WORKFLOW_FILE: FieldPattern = {
  regex: /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/,
  hint: "a file name in `.github/workflows`, ending in `.yml` or `.yaml` (`claude.yml`)",
}

/** A mention that wakes a bot: `@claude`. */
export const MENTION: FieldPattern = {
  regex: /^@[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  hint: "`@`, then letters, digits, `.`, `_`, `/`, or `-` (`@claude`)",
}

/** A bot's login: `claude[bot]`. */
export const BOT_LOGIN: FieldPattern = {
  regex: /^[A-Za-z0-9][A-Za-z0-9._-]*(\[bot\])?$/,
  hint: "a login, optionally ending in `[bot]` (`claude[bot]`)",
}

/** A file system path: `../worktrees`, `~/src/worktrees`. */
export const PATH: FieldPattern = {
  regex: /^[A-Za-z0-9._~/-]+$/,
  hint: "letters, digits, `.`, `_`, `~`, `/`, or `-` (`../worktrees`)",
}

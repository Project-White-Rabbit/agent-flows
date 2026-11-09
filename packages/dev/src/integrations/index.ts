// Every integration, in the order they appear in the config file and the
// configure skill. To add one, write its IntegrationSpec in `<id>/spec.ts`
// (with any built-in adapters in `<id>/adapter.ts`) and list it here; nothing
// else needs to change.

import type { IntegrationSpec } from "../config/types.ts"
import { claude } from "./claude/spec.ts"
import { conductor } from "./conductor/spec.ts"
import { github } from "./github/spec.ts"
import { gitlab } from "./gitlab/spec.ts"
import { graphite } from "./graphite/spec.ts"
import { jira } from "./jira/spec.ts"
import { linear } from "./linear/spec.ts"
import { lore } from "./lore/spec.ts"
import { neon } from "./neon/spec.ts"
import { orca } from "./orca/spec.ts"
import { posthog } from "./posthog/spec.ts"
import { sentry } from "./sentry/spec.ts"
import { slack } from "./slack/spec.ts"
import { superset } from "./superset/spec.ts"
import { vercel } from "./vercel/spec.ts"
import { worktree } from "./worktree/spec.ts"

export const INTEGRATIONS: IntegrationSpec[] = [
  github,
  gitlab,
  graphite,
  claude,
  linear,
  jira,
  vercel,
  neon,
  sentry,
  posthog,
  slack,
  lore,
  superset,
  orca,
  conductor,
  worktree,
]

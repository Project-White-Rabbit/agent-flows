// Every configuration section, in the order they appear in the config file
// and the configure skill. To add one, write a SectionSpec next to these and
// list it here; nothing else needs to change.

import type { SectionSpec } from "../types.ts"
import { github } from "./github.ts"
import { graphite } from "./graphite.ts"
import { linear } from "./linear.ts"
import { neon } from "./neon.ts"
import { posthog } from "./posthog.ts"
import { repo } from "./repo.ts"
import { sentry } from "./sentry.ts"
import { slack } from "./slack.ts"
import { vercel } from "./vercel.ts"

export const SECTIONS: SectionSpec[] = [
  repo,
  github,
  graphite,
  linear,
  vercel,
  neon,
  sentry,
  posthog,
  slack,
]

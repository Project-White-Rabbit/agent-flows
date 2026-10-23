// Every configuration section, in the order they appear in the config file
// and the configure skill. To add an integration, write an IntegrationSpec
// next to these and list it in INTEGRATIONS; nothing else needs to change.

import type { IntegrationSpec, SectionSpec } from "../types.ts"
import { github } from "./github.ts"
import { gitlab } from "./gitlab.ts"
import { graphite } from "./graphite.ts"
import { jira } from "./jira.ts"
import { linear } from "./linear.ts"
import { neon } from "./neon.ts"
import { posthog } from "./posthog.ts"
import { repo } from "./repo.ts"
import { sentry } from "./sentry.ts"
import { slack } from "./slack.ts"
import { vercel } from "./vercel.ts"

export const INTEGRATIONS: IntegrationSpec[] = [
  github,
  gitlab,
  graphite,
  linear,
  jira,
  vercel,
  neon,
  sentry,
  posthog,
  slack,
]

export const SECTIONS: SectionSpec[] = [repo, ...INTEGRATIONS]

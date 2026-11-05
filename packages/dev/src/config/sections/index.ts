// Every configuration section, in the order they appear in the config file
// and the configure skill: the repo's own settings, then every integration
// (registered in src/integrations/index.ts).

import { INTEGRATIONS } from "../../integrations/index.ts"
import type { SectionSpec } from "../types.ts"
import { close } from "./close.ts"
import { evaluate } from "./evaluate.ts"
import { hooks } from "./hooks.ts"
import { merge } from "./merge.ts"
import { ready } from "./ready.ts"
import { repo } from "./repo.ts"
import { sync } from "./sync.ts"
import { tickets } from "./tickets.ts"

export const SECTIONS: SectionSpec[] = [
  repo,
  sync,
  tickets,
  ready,
  evaluate,
  merge,
  close,
  hooks,
  ...INTEGRATIONS,
]

import type { FlowOutputs, GeneratedFile } from "@agent-flows/core"
import { configureFlow } from "./configure.ts"
import { createTicketsFlow } from "./create-tickets.ts"
import { evaluateFlow } from "./evaluate.ts"
import { type DevTargetName, devKit } from "./kit.ts"
import { startWorkFlow } from "./start-work.ts"
import { syncFlow } from "./sync.ts"
import { ticketsToWorkFlow } from "./tickets-to-work.ts"

export const DEV_FLOWS = [
  configureFlow,
  createTicketsFlow,
  evaluateFlow,
  startWorkFlow,
  syncFlow,
  ticketsToWorkFlow,
]

/** Where each flow lands, relative to the package root (the plugin root). */
export const DEV_PROJECTS: FlowOutputs<DevTargetName>[] = DEV_FLOWS.map(
  (flow) => ({
    flow,
    outputs: { claude: `skills/${flow.id}/SKILL.md` },
  }),
)

export function renderAllSkills(): GeneratedFile[] {
  return devKit.renderProject(DEV_PROJECTS)
}

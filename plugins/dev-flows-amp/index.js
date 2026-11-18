// Generated from packages/dev/src/flows by `bun run build`. Do not edit by hand.
// The dev-flows front end for Amp: registers a skill per flow, and each skill
// reads its flow from dev-flows-base.

export const description =
  "Dev workflow commands for any repository: sync, ready, finish, and the rest, from dev-flows-base"

export const SKILL_NAMES = [
  "cancel",
  "configure",
  "create-tickets",
  "evaluate",
  "finish",
  "preview",
  "prototype",
  "ready",
  "server",
  "start-ticket-queue",
  "start-work",
  "sync",
]

export default async function devFlows(amp) {
  for (const skill of SKILL_NAMES) {
    await amp.registerSkill({ path: `skills/${skill}` })
  }
  amp.logger.log(`dev-flows loaded: ${SKILL_NAMES.length} skills`)
}

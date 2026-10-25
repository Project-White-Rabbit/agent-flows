// What sync and create-tickets share about the issues they file, so a branch's
// issue and one filed from planning notes come out the same.

/**
 * How each field under `<fields>` is chosen, after the flow's own sentence on
 * where values come from. "The user" covers what they wrote: in
 * create-tickets, the notes.
 */
export const ISSUE_FIELD_RULES = `- **Priority:** set it when filing, and on an update only when the issue has none. Never change a priority the issue already has, since a person may have set it, unless the user asks to in this session.
- **Labels:** when there's a set to pick from (the agent instructions' or \`values.labels\`), exactly one of it that fits the kind of work. Judge it again on each full update: keep the current one unless another fits strictly better, and never add or remove labels outside the set.
- **Estimate:** when the agent instructions or \`values.estimate\` ask for one, the size of the work on the team's scale, judged again on each full update.
- **Cycle:** the one the user names (\`current\`, \`next\`, or a date inside it); else, when the agent instructions or \`values.cycle\` ask for cycles, \`current\`. Set it when filing, or on an update when the issue has no cycle and isn't done or canceled. Never move an issue out of a cycle it's in unless the user asks.
- **Project:** the one the user or the agent instructions name, else \`values.project\`: when filing, or on an update when the issue has none. Never move an issue out of a project it's in unless the user asks.
- **Assignee:** only the person the user names; left out, a new issue goes to the person running this. Never reassign an issue unless the user asks.
- **Due date:** only when the user gives one. Read a weekday deadline ("Friday", "Mon EOD") as today when today is that weekday, else the next one, and say which date you chose. Never clear one unless the user asks (\`null\`).`

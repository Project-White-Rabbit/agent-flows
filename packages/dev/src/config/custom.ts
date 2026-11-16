// Custom integrations: a tool agent-flows doesn't ship (an in-house tracker, a
// deploy script), defined in the committed config rather than in this plugin.
// An entry at `integrations.<id>` whose id no built-in integration has, with a
// `custom` object, declares what it provides and how it does each op, against
// the same capability contracts the built-in integrations implement:
//
//   "integrations": {
//     "acme-deploy": {
//       "custom": {
//         "name": "Acme Deploy",
//         "access": { "cli": { "bin": "acme" } },
//         "provides": { "deployments": { "deployStatus": { "cli": "`acme status {app}`" } } },
//         "fields": [{ "key": "app", "description": "The app's name in Acme", "required": true }]
//       },
//       "app": "web"
//     }
//   }
//
// The entry's other keys are its values, filled into the ops as `{field}` like
// a built-in's, and `use` works as it does for any integration. Once checked,
// each becomes an IntegrationSpec that joins the registry, so flows get it from
// `configure.ts integrations <capability>` exactly like a built-in one. Ops of
// a capability it leaves out read as unsupported, so flows skip them.
//
// Runtime code: Node built-ins only.

import { INTEGRATIONS } from "../integrations/index.ts"
import { CAPABILITIES } from "./capabilities.ts"
import {
  ACCESS_KINDS,
  type AccessSpec,
  type FieldPattern,
  type FieldSpec,
  type IntegrationSpec,
  type OpImpl,
  type SectionSpec,
} from "./types.ts"

/** The key on an `integrations.<id>` entry that defines a custom integration. */
export const CUSTOM_KEY = "custom"

/** Where custom integrations live. */
const CONTAINER = "integrations"

/** A custom integration's id: its key under `integrations`. */
export const CUSTOM_ID = /^[a-z][a-zA-Z0-9-]*$/

/** A field key a custom integration declares. */
const FIELD_KEY = /^[a-z][a-zA-Z0-9]*$/

/** Keys an entry uses for something other than a value. */
const RESERVED_KEYS = new Set([CUSTOM_KEY, "use", "name", "token"])

/** What a custom integration's values may hold: they land in shell commands. */
export const CUSTOM_VALUE: FieldPattern = {
  regex: /^[\w.@:/+=,~-]+$/,
  hint: "letters, digits, and `_ . @ : / + = , ~ -` only (ops are run as shell commands)",
}

const DEFINITION_KEYS = ["name", "purpose", "access", "provides", "fields"]
const FIELD_DEF_KEYS = ["key", "description", "required"]
const BIN = /^[\w.+-]+$/
const TOKEN_VAR = /^[A-Z][A-Z0-9_]*$/
const PLACEHOLDER = /\{(\w+)(?:\|([a-z0-9.-]+))?(:encoded)?\}/g

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/** True for a path a custom integration may take: `integrations.<id>`. */
export function isCustomPath(path: string): boolean {
  const [container, id, ...rest] = path.split(".")
  return container === CONTAINER && rest.length === 0 && CUSTOM_ID.test(id)
}

/** True when `value` is an entry that defines a custom integration. */
export function definesCustom(value: unknown): boolean {
  return (
    (isRecord(value) && CUSTOM_KEY in value) ||
    (Array.isArray(value) && value.some((v) => isRecord(v) && CUSTOM_KEY in v))
  )
}

export type CustomIntegrations = {
  /** The well-formed ones, as specs that join the registry. */
  specs: IntegrationSpec[]
  /** Every path that tried to define one, well-formed or not. */
  claimed: string[]
  issues: string[]
}

/**
 * The custom integrations `config` defines: each entry under `integrations`
 * whose path isn't in `registry` and that has a `custom` object.
 */
export function customIntegrations(
  config: Record<string, unknown> | undefined,
  registry: SectionSpec[] = INTEGRATIONS,
): CustomIntegrations {
  const out: CustomIntegrations = { specs: [], claimed: [], issues: [] }
  const container = config?.[CONTAINER]
  if (!isRecord(container)) {
    return out
  }
  const known = new Set(registry.map((s) => s.path))
  for (const [id, entry] of Object.entries(container)) {
    const path = `${CONTAINER}.${id}`
    if (known.has(path) || !definesCustom(entry)) {
      continue
    }
    out.claimed.push(path)
    if (!CUSTOM_ID.test(id)) {
      out.issues.push(
        `${path}: a custom integration's id must start with a lowercase letter and hold only letters, digits, and "-"`,
      )
      continue
    }
    if (!isRecord(entry)) {
      out.issues.push(
        `${path}: a custom integration is configured once, as an object, not a list of instances`,
      )
      continue
    }
    const { spec, issues } = customSpec(id, entry)
    out.issues.push(...issues)
    if (spec) {
      out.specs.push(spec)
    }
  }
  return out
}

/** Every integration `config` can use: the built-in ones, then its custom ones. */
export function integrationsFor(
  config: Record<string, unknown> | undefined,
): IntegrationSpec[] {
  return [...INTEGRATIONS, ...customIntegrations(config).specs]
}

/**
 * The spec an entry's `custom` object defines, or the issues that keep it from
 * being one. The entry's values are checked later, like any section's, against
 * the fields this returns.
 */
export function customSpec(
  id: string,
  entry: Record<string, unknown>,
): { spec?: IntegrationSpec; issues: string[] } {
  const path = `${CONTAINER}.${id}`
  const where = `${path}.${CUSTOM_KEY}`
  const def = entry[CUSTOM_KEY]
  if (!isRecord(def)) {
    return {
      issues: [
        `${where} must be an object: {"name", "access", "provides", "fields"}`,
      ],
    }
  }
  const issues: string[] = []
  for (const key of Object.keys(def)) {
    if (!DEFINITION_KEYS.includes(key)) {
      issues.push(
        `${where}.${key} isn't part of a custom integration (it takes ${DEFINITION_KEYS.join(", ")})`,
      )
    }
  }
  if (!nonEmpty(def.name)) {
    issues.push(`${where}.name must be a non-empty string`)
  }
  if (def.purpose !== undefined && !nonEmpty(def.purpose)) {
    issues.push(`${where}.purpose must be a non-empty string`)
  }
  const access = checkAccess(def.access, `${where}.access`, issues)
  const fields = checkFields(def.fields, entry, `${where}.fields`, issues)
  const provides = checkProvides(
    def.provides,
    access,
    fields,
    `${where}.provides`,
    issues,
  )
  if (issues.length > 0) {
    return { issues }
  }
  const name = def.name as string
  // Every op of each capability, so an op it leaves out reads as unsupported
  // rather than missing, and a flow that needs it skips it and says why.
  const complete: Record<string, Record<string, OpImpl>> = {}
  for (const [capabilityId, ops] of Object.entries(provides)) {
    const capability = CAPABILITIES.find((c) => c.id === capabilityId)
    complete[capabilityId] = Object.fromEntries(
      Object.keys(capability?.ops ?? {}).map((op) => [
        op,
        ops[op] ?? { unsupported: `${name} (custom) doesn't define ${op}` },
      ]),
    )
  }
  return {
    spec: {
      path,
      name,
      purpose: (def.purpose as string | undefined) ?? `Custom integration`,
      fields,
      access,
      provides: complete,
      custom: true,
    },
    issues: [],
  }
}

function checkAccess(
  value: unknown,
  where: string,
  issues: string[],
): AccessSpec {
  if (value === undefined) {
    return {}
  }
  if (!isRecord(value)) {
    issues.push(`${where} must be an object: {"mcp", "cli", "api"}`)
    return {}
  }
  const access: AccessSpec = {}
  for (const [kind, how] of Object.entries(value)) {
    if (!(ACCESS_KINDS as readonly string[]).includes(kind)) {
      issues.push(
        `${where}.${kind} isn't a way to reach an integration (${ACCESS_KINDS.join(", ")})`,
      )
      continue
    }
    if (!isRecord(how)) {
      issues.push(`${where}.${kind} must be an object`)
      continue
    }
    if (kind === "mcp") {
      if (!nonEmpty(how.server)) {
        issues.push(
          `${where}.mcp.server must name the MCP server its tools show up under`,
        )
        continue
      }
      access.mcp = { server: how.server }
    } else if (kind === "cli") {
      if (typeof how.bin !== "string" || !BIN.test(how.bin)) {
        issues.push(`${where}.cli.bin must be a command name, like \`acme\``)
        continue
      }
      const auth = how.auth
      if (
        auth !== undefined &&
        !(
          Array.isArray(auth) &&
          auth.length > 0 &&
          auth.every(nonEmpty) &&
          auth[0] === how.bin
        )
      ) {
        issues.push(
          `${where}.cli.auth must be a command as a list of words starting with \`${how.bin}\`, that exits 0 only when signed in`,
        )
        continue
      }
      access.cli = { bin: how.bin, ...(auth ? { auth: auth as string[] } : {}) }
    } else {
      const token = how.token
      if (!nonEmpty(how.base)) {
        issues.push(`${where}.api.base must say where the API lives`)
        continue
      }
      if (
        !Array.isArray(token) ||
        token.length === 0 ||
        !token.every((t) => typeof t === "string" && TOKEN_VAR.test(t))
      ) {
        issues.push(
          `${where}.api.token must list the environment variables that may hold its token, like ["ACME_TOKEN"]`,
        )
        continue
      }
      access.api = { base: how.base, token: token as string[] }
    }
  }
  return access
}

/**
 * Its fields: the ones it declares, plus every value the entry sets that it
 * doesn't declare (required, since it's set). All of them take only values
 * safe in a shell command.
 */
function checkFields(
  value: unknown,
  entry: Record<string, unknown>,
  where: string,
  issues: string[],
): FieldSpec[] {
  const fields: FieldSpec[] = []
  if (value !== undefined && !Array.isArray(value)) {
    issues.push(`${where} must be a list of {"key", "description", "required"}`)
  }
  for (const [index, field] of (Array.isArray(value) ? value : []).entries()) {
    const at = `${where}[${index}]`
    if (!isRecord(field)) {
      issues.push(`${at} must be an object: {"key", "description", "required"}`)
      continue
    }
    const extra = Object.keys(field).filter((k) => !FIELD_DEF_KEYS.includes(k))
    if (extra.length > 0) {
      issues.push(
        `${at} takes only ${FIELD_DEF_KEYS.join(", ")}, not ${extra.join(", ")}`,
      )
    }
    const key = field.key
    if (typeof key !== "string" || !FIELD_KEY.test(key)) {
      issues.push(`${at}.key must be a camelCase name, like \`app\``)
      continue
    }
    if (RESERVED_KEYS.has(key)) {
      issues.push(
        `${at}.key can't be \`${key}\`: the entry uses it for something else`,
      )
      continue
    }
    if (fields.some((f) => f.key === key)) {
      issues.push(`${where} declares \`${key}\` twice`)
      continue
    }
    if (!nonEmpty(field.description)) {
      issues.push(`${at}.description must say what \`${key}\` holds`)
    }
    if (field.required !== undefined && typeof field.required !== "boolean") {
      issues.push(`${at}.required must be true or false`)
    }
    fields.push({
      key,
      description: String(field.description ?? key),
      example: "value",
      pattern: CUSTOM_VALUE,
      ...(field.required === true ? { required: true } : {}),
    })
  }
  for (const key of Object.keys(entry)) {
    if (RESERVED_KEYS.has(key) || fields.some((f) => f.key === key)) {
      continue
    }
    fields.push({
      key,
      description: `A value of this custom integration`,
      example: "value",
      pattern: CUSTOM_VALUE,
      required: true,
    })
  }
  return fields
}

function checkProvides(
  value: unknown,
  access: AccessSpec,
  fields: FieldSpec[],
  where: string,
  issues: string[],
): Record<string, Record<string, OpImpl>> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    issues.push(
      `${where} must name at least one capability, like {"deployments": {"<op>": "<how>"}} (see \`configure.ts capabilities\`)`,
    )
    return {}
  }
  const out: Record<string, Record<string, OpImpl>> = {}
  for (const [capabilityId, ops] of Object.entries(value)) {
    const capability = CAPABILITIES.find((c) => c.id === capabilityId)
    if (!capability) {
      issues.push(
        `${where}.${capabilityId} isn't a capability (known: ${CAPABILITIES.map((c) => c.id).join(", ")})`,
      )
      continue
    }
    // A capability flows ask no ops of yet (`database`) is provided by `{}`.
    const none = Object.keys(capability.ops).length === 0
    if (!isRecord(ops) || (Object.keys(ops).length === 0 && !none)) {
      issues.push(
        `${where}.${capabilityId} must give at least one of its ops: ${Object.keys(capability.ops).join(", ")}`,
      )
      continue
    }
    out[capabilityId] = {}
    for (const [op, impl] of Object.entries(ops)) {
      const at = `${where}.${capabilityId}.${op}`
      if (!(op in capability.ops)) {
        issues.push(
          `${at}: ${capabilityId} has no op \`${op}\` (its ops: ${Object.keys(capability.ops).join(", ")})`,
        )
        continue
      }
      const checked = checkOp(impl, access, fields, at)
      issues.push(...checked)
      if (checked.length === 0) {
        out[capabilityId][op] = impl as OpImpl
      }
    }
  }
  return out
}

function checkOp(
  impl: unknown,
  access: AccessSpec,
  fields: FieldSpec[],
  at: string,
): string[] {
  if (typeof impl === "string") {
    return impl.trim() === ""
      ? [`${at} must say how to do it`]
      : checkPlaceholders(impl, "any", fields, at)
  }
  if (!isRecord(impl) || Object.keys(impl).length === 0) {
    return [
      `${at} must be a string, an object of one way per access kind ({"cli": "..."}), or {"unsupported": "<why>"}`,
    ]
  }
  if ("unsupported" in impl) {
    return Object.keys(impl).length === 1 && nonEmpty(impl.unsupported)
      ? []
      : [`${at}.unsupported must say why, and stand alone`]
  }
  const issues: string[] = []
  for (const [kind, how] of Object.entries(impl)) {
    if (kind === "script") {
      issues.push(
        `${at}.script: a script variant comes from an adapter in .agent-flows/adapters/<id>.ts, not from the config`,
      )
      continue
    }
    if (!(ACCESS_KINDS as readonly string[]).includes(kind)) {
      issues.push(
        `${at}.${kind} isn't a way to reach an integration (${ACCESS_KINDS.join(", ")})`,
      )
      continue
    }
    if (!(kind in access)) {
      issues.push(
        `${at}.${kind}: the integration declares no \`${kind}\` access, so this variant can't be probed (add it to \`access\`)`,
      )
      continue
    }
    if (!nonEmpty(how)) {
      issues.push(`${at}.${kind} must say how to do it`)
      continue
    }
    issues.push(...checkPlaceholders(how, kind, fields, `${at}.${kind}`))
  }
  return issues
}

function checkPlaceholders(
  how: string,
  kind: string,
  fields: FieldSpec[],
  at: string,
): string[] {
  const issues: string[] = []
  for (const [, key, fallback] of how.matchAll(PLACEHOLDER)) {
    if (key === "token") {
      if (kind !== "api") {
        issues.push(
          `${at} uses {token}: only an \`api\` variant may, so the token is read only where it's needed`,
        )
      }
      continue
    }
    const field = fields.find((f) => f.key === key)
    if (!field) {
      issues.push(
        `${at} uses {${key}}, which is neither a declared field nor a value the entry sets`,
      )
    } else if (!field.required && !fallback) {
      issues.push(
        `${at} uses optional {${key}} with no default: make it required, or write {${key}|<default>}`,
      )
    }
  }
  return issues
}

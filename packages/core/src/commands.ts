export interface CommandCatalogEntry {
  file: string
}

export interface CommandDefinition {
  file: string
  description: string
  args?: string
}

export interface CommandUse<CommandId extends string = string> {
  command?: CommandId
  description: string
  args?: string
}

export function defineCommandCatalog<
  const Catalog extends Record<string, CommandCatalogEntry>,
>(catalog: Catalog) {
  type CommandId = Extract<keyof Catalog, string>

  return {
    defineCommands<const Defs extends Record<string, CommandUse<CommandId>>>(
      defs: Defs,
    ): { [K in keyof Defs]: CommandDefinition } {
      const out: Record<string, CommandDefinition> = {}
      for (const [flowCommandId, def] of Object.entries(defs)) {
        const catalogId = def.command ?? flowCommandId
        const entry = catalog[catalogId]
        if (entry === undefined) {
          throw new Error(
            `Flow command "${flowCommandId}" references unknown command "${catalogId}"`,
          )
        }
        out[flowCommandId] = {
          file: entry.file,
          description: def.description,
          ...(def.args === undefined ? {} : { args: def.args }),
        }
      }
      return out as { [K in keyof Defs]: CommandDefinition }
    },
  }
}

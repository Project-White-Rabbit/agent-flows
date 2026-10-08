import { describe, expect, it } from "vitest"
import { defineCommandCatalog } from "./commands.js"

describe("defineCommandCatalog", () => {
  const commands = defineCommandCatalog({
    status: { file: "status.js" },
    pageLink: { file: "pageLink.js" },
  })

  it("fills command files from the catalog", () => {
    expect(
      commands.defineCommands({
        status: { description: "Check status" },
      }),
    ).toEqual({
      status: {
        file: "status.js",
        description: "Check status",
      },
    })
  })

  it("supports flow-local aliases for catalog commands", () => {
    expect(
      commands.defineCommands({
        linkToPage: {
          command: "pageLink",
          description: "Print a page link",
          args: "<path>",
        },
      }),
    ).toEqual({
      linkToPage: {
        file: "pageLink.js",
        description: "Print a page link",
        args: "<path>",
      },
    })
  })

  it("rejects omitted command ids that are not in the catalog", () => {
    expect(() =>
      commands.defineCommands({
        missing: { description: "Missing" },
      }),
    ).toThrow('Flow command "missing" references unknown command "missing"')
  })
})

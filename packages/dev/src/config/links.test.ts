import { describe, expect, it } from "vitest"
import { plainDocumentLinks } from "./links.ts"

const URL =
  "https://linear.app/acme/document/planning-week-of-2026-11-02-1a2b3c"
const LINK = `[Planning, week of 2026-11-02](${URL})`

describe("plainDocumentLinks", () => {
  it("turns a self-closing tag into the link, titled by its label", () => {
    expect(
      plainDocumentLinks(
        `> Planning: <document id="d1" label="Planning, week of 2026-11-02" href="${URL}" />, from notes`,
      ),
    ).toBe(`> Planning: ${LINK}, from notes`)
  })

  it("turns a paired tag into the link, titled by its text", () => {
    expect(
      plainDocumentLinks(
        `<document id="d1" href="${URL}">Planning, week of 2026-11-02</document>`,
      ),
    ).toBe(LINK)
  })

  it("repairs an href an earlier API write nested", () => {
    const nested = `href="[Planning, week of 2026-11-02](${URL})"`
    expect(
      plainDocumentLinks(
        `<document id="d1" label="Planning, week of 2026-11-02" ${nested} />`,
      ),
    ).toBe(LINK)
    expect(
      plainDocumentLinks(
        `<document id="d1" ${nested}>Planning, week of 2026-11-02</document>`,
      ),
    ).toBe(LINK)
  })

  it("reads attributes in any order and quoting", () => {
    for (const tag of [
      `<document href="${URL}" label="Planning, week of 2026-11-02" id="d1"/>`,
      `<document label='Planning, week of 2026-11-02' id=d1 href='${URL}' />`,
      `<document\n  href="${URL}"\n  label="Planning, week of 2026-11-02"\n/>`,
    ]) {
      expect(plainDocumentLinks(tag)).toBe(LINK)
    }
  })

  it("falls back to the URL for a title, and to the title without a URL", () => {
    expect(plainDocumentLinks(`<document id="d1" href="${URL}" />`)).toBe(
      `[${URL}](${URL})`,
    )
    expect(plainDocumentLinks('<document id="d1" label="Notes" />')).toBe(
      "Notes",
    )
    expect(
      plainDocumentLinks('<document id="d1" href="#">Notes</document>'),
    ).toBe("Notes")
  })

  it("decodes escaped characters in attributes", () => {
    expect(
      plainDocumentLinks(
        '<document label="Q&amp;A" href="https://x.test/d?a=1&amp;b=2" />',
      ),
    ).toBe("[Q&A](https://x.test/d?a=1&b=2)")
  })

  it("leaves plain text and links as they are", () => {
    const text = [
      "> Branch: `eng-1-fix`",
      `> Planning: ${LINK}`,
      "",
      "## Description",
      "",
      "Compare a <documentation> page with <doc> and a `<document />` mention?",
    ].join("\n")
    expect(plainDocumentLinks(text)).toBe(text)
  })

  it("changes nothing on a second run", () => {
    const text = [
      `> Planning: <document id="d1" label="Planning, week of 2026-11-02" href="${URL}" />`,
      `> Spec: <document id="d2" href="[Spec](https://linear.app/acme/document/spec-9f)">Spec</document>`,
      "",
      "Body",
    ].join("\n")
    const once = plainDocumentLinks(text)
    expect(once).toBe(
      [
        `> Planning: ${LINK}`,
        "> Spec: [Spec](https://linear.app/acme/document/spec-9f)",
        "",
        "Body",
      ].join("\n"),
    )
    expect(plainDocumentLinks(once)).toBe(once)
  })
})

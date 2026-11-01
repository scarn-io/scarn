import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "./parse-markdown";

describe("parseMarkdown", () => {
  test("splits headings, paragraphs and lists", () => {
    const blocks = parseMarkdown(
      [
        "Intro line one",
        "continues here.",
        "",
        "### Hand-off steps",
        "",
        "- **research** answers.",
        "- **prototype** builds",
        "  a spike.",
        "",
        "1. first",
        "2. second",
      ].join("\n"),
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "heading",
      "list",
      "list",
    ]);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      children: [{ kind: "text", text: "Intro line one continues here." }],
    });
    expect(blocks[1]).toEqual({
      kind: "heading",
      level: 3,
      children: [{ kind: "text", text: "Hand-off steps" }],
    });
    const list = blocks[2];
    expect(list?.kind === "list" && list.items.length).toBe(2);
    expect(list?.kind === "list" && list.items[1]).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "prototype" }] },
      { kind: "text", text: " builds a spike." },
    ]);
    expect(blocks[3]?.kind === "list" && blocks[3].ordered).toBe(true);
  });
});

describe("parseInline", () => {
  test("reads code, bold, italics and links", () => {
    expect(
      parseInline(
        'Use `assign("x")`, **bold**, *it* and [docs](https://x.dev).',
      ),
    ).toEqual([
      { kind: "text", text: "Use " },
      { kind: "code", text: 'assign("x")' },
      { kind: "text", text: ", " },
      { kind: "strong", children: [{ kind: "text", text: "bold" }] },
      { kind: "text", text: ", " },
      { kind: "em", children: [{ kind: "text", text: "it" }] },
      { kind: "text", text: " and " },
      {
        kind: "link",
        href: "https://x.dev",
        children: [{ kind: "text", text: "docs" }],
      },
      { kind: "text", text: "." },
    ]);
  });

  test("drops links with unsafe schemes to plain text", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([
      { kind: "text", text: "click" },
      { kind: "text", text: ")" },
    ]);
  });

  test("leaves snake_case and unmatched markers alone", () => {
    expect(parseInline("a_b_c and 2 * 3")).toEqual([
      { kind: "text", text: "a_b_c and 2 * 3" },
    ]);
  });
});

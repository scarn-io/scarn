import { describe, expect } from "bun:test";
import {
  adfLinkMark,
  adfText,
  markdownToAdf,
  type AdfNode,
} from "@/integrations/jira-ingest/infra/markdown-to-adf";
import { concurrentTest } from "tests/utils";

const paragraph = (...content: AdfNode[]): AdfNode => ({
  type: "paragraph",
  content,
});

describe("markdownToAdf", () => {
  concurrentTest("converts paragraphs, headings and inline marks", () => {
    const doc = markdownToAdf(
      "## Repro\n\nThis is *very* **bad** and `npm test` ~~works~~.",
    );

    expect(doc).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [adfText("Repro")] },
        paragraph(
          adfText("This is "),
          adfText("very", [{ type: "em" }]),
          adfText(" "),
          adfText("bad", [{ type: "strong" }]),
          adfText(" and "),
          adfText("npm test", [{ type: "code" }]),
          adfText(" "),
          adfText("works", [{ type: "strike" }]),
          adfText("."),
        ),
      ],
    });
  });

  concurrentTest("keeps only the link mark alongside code", () => {
    const doc = markdownToAdf("**[`run()`](https://x.test)**");
    expect(doc.content).toEqual([
      paragraph(
        adfText("run()", [adfLinkMark("https://x.test"), { type: "code" }]),
      ),
    ]);
  });

  concurrentTest("converts links, reference links and hard breaks", () => {
    const doc = markdownToAdf(
      "See [docs](https://docs.test)  \nand [ref][r].\n\n[r]: https://ref.test",
    );
    expect(doc.content).toEqual([
      paragraph(
        adfText("See "),
        adfText("docs", [adfLinkMark("https://docs.test")]),
        { type: "hardBreak" },
        adfText("and "),
        adfText("ref", [adfLinkMark("https://ref.test")]),
        adfText("."),
      ),
    ]);
  });

  concurrentTest("converts code blocks with and without a language", () => {
    const doc = markdownToAdf("```ts\nconst a = 1;\n```\n\n    indented");
    expect(doc.content).toEqual([
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [adfText("const a = 1;")],
      },
      { type: "codeBlock", content: [adfText("indented")] },
    ]);
  });

  concurrentTest("converts nested and ordered lists", () => {
    const doc = markdownToAdf("3. one\n4. two\n   - nested\n");
    expect(doc.content).toEqual([
      {
        type: "orderedList",
        attrs: { order: 3 },
        content: [
          { type: "listItem", content: [paragraph(adfText("one"))] },
          {
            type: "listItem",
            content: [
              paragraph(adfText("two")),
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [paragraph(adfText("nested"))] },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  concurrentTest(
    "converts blockquotes, flattening headings inside them",
    () => {
      const doc = markdownToAdf("> # Title\n> quoted\n\n---");
      expect(doc.content).toEqual([
        {
          type: "blockquote",
          content: [paragraph(adfText("Title")), paragraph(adfText("quoted"))],
        },
        { type: "rule" },
      ]);
    },
  );

  concurrentTest("falls back to text for HTML and images", () => {
    const doc = markdownToAdf(
      "<details>raw</details>\n\n![shot](https://img.test/a.png)",
    );
    expect(doc.content).toEqual([
      paragraph(adfText("<details>raw</details>")),
      paragraph(adfText("shot", [adfLinkMark("https://img.test/a.png")])),
    ]);
  });

  concurrentTest("converts GFM tables", () => {
    const doc = markdownToAdf("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(doc.content).toEqual([
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph(adfText("a"))] },
              { type: "tableHeader", content: [paragraph(adfText("b"))] },
            ],
          },
          {
            type: "tableRow",
            content: [
              { type: "tableCell", content: [paragraph(adfText("1"))] },
              { type: "tableCell", content: [paragraph(adfText("2"))] },
            ],
          },
        ],
      },
    ]);
  });

  concurrentTest("returns an empty document for a blank body", () => {
    expect(markdownToAdf("\n  \n")).toEqual({
      type: "doc",
      version: 1,
      content: [],
    });
  });
});

describe("markdownToAdf placeholders", () => {
  const media: AdfNode = { type: "mediaSingle", attrs: { layout: "center" } };
  const link = adfText("the log", [adfLinkMark("https://app.test/log")]);

  concurrentTest("puts block nodes where a standalone placeholder was", () => {
    const body = "Intro\n\n![Video](artifact:video.mp4)\n\nOutro";
    const start = body.indexOf("![");
    const end = body.indexOf(")") + 1;

    const doc = markdownToAdf(body, [
      { range: { start, end }, block: [media], inline: [link] },
    ]);

    expect(doc.content).toEqual([
      paragraph(adfText("Intro")),
      media,
      paragraph(adfText("Outro")),
    ]);
  });

  concurrentTest(
    "puts inline nodes, with surrounding marks, inside text",
    () => {
      const body = "See **[log](artifact:log.txt)** now.";
      const start = body.indexOf("[");
      const end = body.indexOf(")") + 1;

      const doc = markdownToAdf(body, [
        { range: { start, end }, block: [media], inline: [link] },
      ]);

      expect(doc.content).toEqual([
        paragraph(
          adfText("See "),
          adfText("the log", [
            { type: "strong" },
            adfLinkMark("https://app.test/log"),
          ]),
          adfText(" now."),
        ),
      ]);
    },
  );

  concurrentTest("restores a placeholder's source text inside code", () => {
    const body = "```\n![x](artifact:a.png)\n```";
    const start = body.indexOf("![");
    const end = body.indexOf(")") + 1;

    const doc = markdownToAdf(body, [
      { range: { start, end }, block: [media], inline: [link] },
    ]);

    expect(doc.content).toEqual([
      { type: "codeBlock", content: [adfText("![x](artifact:a.png)")] },
    ]);
  });

  concurrentTest("fills in several placeholders in a list", () => {
    const body = "- [a](artifact:a)\n- [b](artifact:b)";
    const ranges = [...body.matchAll(/\[[ab]\]\(artifact:[ab]\)/g)].map(
      (match) => ({ start: match.index, end: match.index + match[0].length }),
    );
    const doc = markdownToAdf(
      body,
      ranges.map((range, index) => ({
        range,
        block: [],
        inline: [adfText(`link ${String(index)}`)],
      })),
    );
    expect(doc.content).toEqual([
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [paragraph(adfText("link 0"))] },
          { type: "listItem", content: [paragraph(adfText("link 1"))] },
        ],
      },
    ]);
  });
});

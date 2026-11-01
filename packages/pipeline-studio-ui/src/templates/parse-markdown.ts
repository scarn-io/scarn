/**
 * A minimal Markdown parser for template descriptions: ATX headings,
 * paragraphs, `-`/`*`/`1.` lists, and inline code, bold, italics and links.
 * It produces a small tree that `MarkdownView.tsx` renders as React elements, so
 * no HTML string ever reaches the DOM.
 */

export type MarkdownInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: MarkdownInline[] }
  | { kind: "em"; children: MarkdownInline[] }
  | { kind: "link"; href: string; children: MarkdownInline[] };

export type MarkdownBlock =
  | {
      kind: "heading";
      level: 1 | 2 | 3 | 4 | 5 | 6;
      children: MarkdownInline[];
    }
  | { kind: "paragraph"; children: MarkdownInline[] }
  | { kind: "list"; ordered: boolean; items: MarkdownInline[][] };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const UNORDERED_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const SAFE_HREF = /^(https?:|mailto:|\/|#)/i;

function listItem(line: string): { ordered: boolean; text: string } | null {
  const unordered = UNORDERED_ITEM.exec(line);
  if (unordered) return { ordered: false, text: unordered[1] ?? "" };
  const ordered = ORDERED_ITEM.exec(line);
  if (ordered) return { ordered: true, text: ordered[1] ?? "" };
  return null;
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({
        kind: "paragraph",
        children: parseInline(paragraph.join(" ")),
      });
      paragraph = [];
    }
    if (list) {
      blocks.push({
        kind: "list",
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(item)),
      });
      list = null;
    }
  };

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: (heading[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2] ?? ""),
      });
      continue;
    }
    const item = listItem(line);
    if (item && paragraph.length === 0) {
      if (list && list.ordered !== item.ordered) flush();
      list ??= { ordered: item.ordered, items: [] };
      list.items.push(item.text);
      continue;
    }
    if (list && /^\s+\S/.test(rawLine)) {
      const last = list.items.length - 1;
      list.items[last] = `${list.items[last] ?? ""} ${line.trim()}`;
      continue;
    }
    if (list) flush();
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

export function parseInline(text: string): MarkdownInline[] {
  const result: MarkdownInline[] = [];
  let buffer = "";
  const pushText = () => {
    if (buffer) result.push({ kind: "text", text: buffer });
    buffer = "";
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const rest = text.slice(index);

    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      if (close !== -1) {
        pushText();
        result.push({ kind: "code", text: text.slice(index + 1, close) });
        index = close + 1;
        continue;
      }
    }

    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.slice(0, 2);
      const close = text.indexOf(marker, index + 2);
      if (close > index + 2) {
        pushText();
        result.push({
          kind: "strong",
          children: parseInline(text.slice(index + 2, close)),
        });
        index = close + 2;
        continue;
      }
    }

    if (char === "*" || (char === "_" && !/\w/.test(text[index - 1] ?? ""))) {
      const close = text.indexOf(char, index + 1);
      if (close > index + 1 && !/\s/.test(text[index + 1] ?? " ")) {
        pushText();
        result.push({
          kind: "em",
          children: parseInline(text.slice(index + 1, close)),
        });
        index = close + 1;
        continue;
      }
    }

    if (char === "[") {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
      if (link) {
        const href = link[2] ?? "";
        pushText();
        const children = parseInline(link[1] ?? "");
        result.push(
          SAFE_HREF.test(href)
            ? { kind: "link", href, children }
            : { kind: "text", text: link[1] ?? "" },
        );
        index += link[0].length;
        continue;
      }
    }

    buffer += text.charAt(index);
    index += 1;
  }
  pushText();
  return result;
}

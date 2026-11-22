/**
 * Markdown (CommonMark + GFM) to Atlassian Document Format, for Jira Cloud's
 * v3 comment API. Parses with `mdast-util-from-markdown` and walks the tree.
 *
 * Callers can swap ranges of the source for ready-made ADF through
 * placeholders: each range is replaced by an opaque token before parsing, and
 * the token is filled in afterwards — with `block` nodes when it is a
 * paragraph on its own, or with `inline` nodes when it sits among other text.
 * Inside code, a token turns back into its original source text.
 *
 * `marklassian` was evaluated first: it can only pass raw ADF through as a
 * block-level `<adf>` HTML tag, so it can't place inline nodes or tell where a
 * marker landed.
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type {
  List,
  ListItem,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from "mdast";

export type AdfMark = { type: string; attrs?: AnyJsonObject };

export type AdfNode = {
  type: string;
  attrs?: AnyJsonObject;
  content?: AdfNode[];
  marks?: AdfMark[];
  text?: string;
};

export type AdfDocument = { type: "doc"; version: 1; content: AdfNode[] };

export type AdfPlaceholder = {
  range: { start: number; end: number };
  /** Used when the placeholder is a paragraph on its own, unless empty. */
  block: AdfNode[];
  /** Used when the placeholder sits inside other text. */
  inline: AdfNode[];
};

const LINK_ONLY_WITH_CODE = new Set(["code", "link"]);

export const adfLinkMark = (href: string): AdfMark => ({
  type: "link",
  attrs: { href },
});

export const adfText = (text: string, marks: AdfMark[] = []): AdfNode => {
  const allowed = marks.some((mark) => mark.type === "code")
    ? marks.filter((mark) => LINK_ONLY_WITH_CODE.has(mark.type))
    : marks;
  return allowed.length > 0
    ? { type: "text", text, marks: allowed }
    : { type: "text", text };
};

export const adfParagraph = (content: AdfNode[]): AdfNode => ({
  type: "paragraph",
  content,
});

export const adfHardBreak = (): AdfNode => ({ type: "hardBreak" });

const TOKEN_PATTERN = /\uE000(\d+)\uE001/g;
const SOLE_TOKEN_PATTERN = /^\s*\uE000(\d+)\uE001\s*$/;
const placeholderToken = (index: number): string =>
  `\uE000${String(index)}\uE001`;

type Context = {
  placeholders: readonly AdfPlaceholder[];
  sources: readonly string[];
  definitions: ReadonlyMap<string, string>;
};

const BLOCKQUOTE_CHILDREN = new Set([
  "paragraph",
  "bulletList",
  "orderedList",
  "codeBlock",
  "mediaGroup",
  "mediaSingle",
]);
const LIST_ITEM_CHILDREN = new Set([
  "paragraph",
  "bulletList",
  "orderedList",
  "codeBlock",
  "mediaSingle",
]);
const LIST_ITEM_FIRST_CHILDREN = new Set([
  "paragraph",
  "codeBlock",
  "mediaSingle",
]);

const plainText = (node: Nodes): string => {
  if ("value" in node) return node.value;
  if ("children" in node) {
    return (node.children as Nodes[]).map(plainText).join("");
  }
  return "";
};

const restoreSource = (value: string, ctx: Context): string =>
  value.replace(
    TOKEN_PATTERN,
    (_token, index: string) => ctx.sources[Number(index)] ?? "",
  );

const withMarks = (node: AdfNode, marks: AdfMark[]): AdfNode => {
  if (node.type !== "text" || marks.length === 0) return node;
  const own = node.marks ?? [];
  const ownTypes = new Set(own.map((mark) => mark.type));
  return adfText(node.text ?? "", [
    ...marks.filter((mark) => !ownTypes.has(mark.type)),
    ...own,
  ]);
};

const textWithPlaceholders = (
  value: string,
  marks: AdfMark[],
  ctx: Context,
): AdfNode[] => {
  const nodes: AdfNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(TOKEN_PATTERN)) {
    if (match.index > cursor) {
      nodes.push(adfText(value.slice(cursor, match.index), marks));
    }
    const placeholder = ctx.placeholders[Number(match[1])];
    if (placeholder) {
      nodes.push(...placeholder.inline.map((node) => withMarks(node, marks)));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) nodes.push(adfText(value.slice(cursor), marks));
  return nodes;
};

const withoutLink = (marks: AdfMark[]): AdfMark[] =>
  marks.filter((mark) => mark.type !== "link");

const inlineNodes = (
  nodes: readonly PhrasingContent[],
  marks: AdfMark[],
  ctx: Context,
): AdfNode[] => nodes.flatMap((node) => inlineNode(node, marks, ctx));

const inlineNode = (
  node: PhrasingContent,
  marks: AdfMark[],
  ctx: Context,
): AdfNode[] => {
  switch (node.type) {
    case "text":
    case "html":
      return textWithPlaceholders(node.value, marks, ctx);
    case "emphasis":
      return inlineNodes(node.children, [...marks, { type: "em" }], ctx);
    case "strong":
      return inlineNodes(node.children, [...marks, { type: "strong" }], ctx);
    case "delete":
      return inlineNodes(node.children, [...marks, { type: "strike" }], ctx);
    case "inlineCode":
      return [
        adfText(restoreSource(node.value, ctx), [...marks, { type: "code" }]),
      ];
    case "break":
      return [adfHardBreak()];
    case "link":
      return inlineNodes(
        node.children,
        [...withoutLink(marks), adfLinkMark(node.url)],
        ctx,
      );
    case "linkReference": {
      const href = ctx.definitions.get(node.identifier);
      return inlineNodes(
        node.children,
        href ? [...withoutLink(marks), adfLinkMark(href)] : marks,
        ctx,
      );
    }
    case "image":
      return [
        adfText(node.alt || node.url, [
          ...withoutLink(marks),
          adfLinkMark(node.url),
        ]),
      ];
    case "imageReference": {
      const href = ctx.definitions.get(node.identifier);
      const label = node.alt || node.label || node.identifier;
      return [
        adfText(
          label,
          href ? [...withoutLink(marks), adfLinkMark(href)] : marks,
        ),
      ];
    }
    default:
      return textWithPlaceholders(plainText(node), marks, ctx);
  }
};

const collectInline = (node: AdfNode): AdfNode[] =>
  node.type === "text" || node.type === "hardBreak"
    ? [node]
    : (node.content ?? []).flatMap(collectInline);

const constrainTo = (
  nodes: readonly AdfNode[],
  allowed: ReadonlySet<string>,
): AdfNode[] =>
  nodes.flatMap((node) =>
    allowed.has(node.type) ? [node] : [adfParagraph(collectInline(node))],
  );

const listItem = (item: ListItem, ctx: Context): AdfNode => {
  const content = constrainTo(
    blockNodes(item.children, ctx),
    LIST_ITEM_CHILDREN,
  );
  const [first] = content;
  return {
    type: "listItem",
    content:
      first && LIST_ITEM_FIRST_CHILDREN.has(first.type)
        ? content
        : [adfParagraph([]), ...content],
  };
};

const list = (node: List, ctx: Context): AdfNode => {
  const content = node.children.map((item) => listItem(item, ctx));
  if (!node.ordered) return { type: "bulletList", content };
  return node.start !== null && node.start !== undefined && node.start !== 1
    ? { type: "orderedList", attrs: { order: node.start }, content }
    : { type: "orderedList", content };
};

const table = (node: Table, ctx: Context): AdfNode => ({
  type: "table",
  content: node.children.map((row, rowIndex) => ({
    type: "tableRow",
    content: row.children.map((cell) => ({
      type: rowIndex === 0 ? "tableHeader" : "tableCell",
      content: [adfParagraph(inlineNodes(cell.children, [], ctx))],
    })),
  })),
});

const soleParagraphPlaceholder = (
  children: readonly PhrasingContent[],
  ctx: Context,
): AdfPlaceholder | null => {
  const [only] = children;
  if (children.length !== 1 || only?.type !== "text") return null;
  const match = SOLE_TOKEN_PATTERN.exec(only.value);
  return match ? (ctx.placeholders[Number(match[1])] ?? null) : null;
};

const blockNodes = (nodes: readonly RootContent[], ctx: Context): AdfNode[] =>
  nodes.flatMap((node) => blockNode(node, ctx));

const blockNode = (node: RootContent, ctx: Context): AdfNode[] => {
  switch (node.type) {
    case "paragraph": {
      const placeholder = soleParagraphPlaceholder(node.children, ctx);
      if (placeholder && placeholder.block.length > 0) return placeholder.block;
      const content = inlineNodes(node.children, [], ctx);
      return content.length > 0 ? [adfParagraph(content)] : [];
    }
    case "heading":
      return [
        {
          type: "heading",
          attrs: { level: node.depth },
          content: inlineNodes(node.children, [], ctx),
        },
      ];
    case "thematicBreak":
      return [{ type: "rule" }];
    case "blockquote": {
      const content = constrainTo(
        blockNodes(node.children, ctx),
        BLOCKQUOTE_CHILDREN,
      );
      return content.length > 0 ? [{ type: "blockquote", content }] : [];
    }
    case "code": {
      const text = restoreSource(node.value, ctx);
      return [
        {
          type: "codeBlock",
          ...(node.lang ? { attrs: { language: node.lang } } : {}),
          content: text ? [adfText(text)] : [],
        },
      ];
    }
    case "list":
      return [list(node, ctx)];
    case "table":
      return [table(node, ctx)];
    case "definition":
      return [];
    case "footnoteDefinition":
      return blockNodes(node.children, ctx);
    default: {
      const content = textWithPlaceholders(plainText(node), [], ctx);
      return content.length > 0 ? [adfParagraph(content)] : [];
    }
  }
};

const collectDefinitions = (root: Root): Map<string, string> => {
  const definitions = new Map<string, string>();
  const visit = (node: Nodes): void => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    if ("children" in node) (node.children as Nodes[]).forEach(visit);
  };
  visit(root);
  return definitions;
};

/** Converts a markdown body to an ADF document, filling in placeholders. */
export const markdownToAdf = (
  markdown: string,
  placeholders: readonly AdfPlaceholder[] = [],
): AdfDocument => {
  const ordered = placeholders
    .map((placeholder, index) => ({ placeholder, index }))
    .sort((a, b) => a.placeholder.range.start - b.placeholder.range.start);

  const sources: string[] = [];
  let source = "";
  let cursor = 0;
  for (const { placeholder, index } of ordered) {
    const { start, end } = placeholder.range;
    if (start < cursor) continue;
    source += markdown.slice(cursor, start) + placeholderToken(index);
    sources[index] = markdown.slice(start, end);
    cursor = end;
  }
  source += markdown.slice(cursor);

  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const ctx: Context = {
    placeholders,
    sources,
    definitions: collectDefinitions(tree),
  };
  return { type: "doc", version: 1, content: blockNodes(tree.children, ctx) };
};

import { useMemo, type ReactNode } from "react";
import {
  parseInline,
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "./parse-markdown";

function renderInline(nodes: readonly MarkdownInline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return node.text;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "link":
        return (
          <a key={index} href={node.href} target="_blank" rel="noreferrer">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

function renderBlock(block: MarkdownBlock, index: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const Heading = `h${String(block.level)}` as "h1";
      return <Heading key={index}>{renderInline(block.children)}</Heading>;
    }
    case "paragraph":
      return <p key={index}>{renderInline(block.children)}</p>;
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List key={index}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item)}</li>
          ))}
        </List>
      );
    }
  }
}

/** Renders `parseMarkdown`'s tree as React elements; never sets raw HTML. */
export function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className={className}>{blocks.map(renderBlock)}</div>;
}

/** One line of inline Markdown (code, bold, links) inside a `<span>`. */
export function InlineMarkdown({ text }: { text: string }) {
  const nodes = useMemo(() => parseInline(text), [text]);
  return <span>{renderInline(nodes)}</span>;
}

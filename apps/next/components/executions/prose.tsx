"use client";

/**
 * Agent narration and work item descriptions rendered as GitHub-flavoured
 * Markdown. Raw HTML in the text is dropped, never rendered.
 */

import { useMemo, type ReactNode } from "react";
import { Box } from "@mui/material";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

export type ProseLink = { href: string | undefined; children: ReactNode };

/** A link that opens in a new tab: how `Prose` renders every link by default. */
export function ExternalProseLink({ href, children }: ProseLink) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

const DEFAULT_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <ExternalProseLink href={href}>{children}</ExternalProseLink>
  ),
};

/**
 * `renderLink` replaces how links render. It is given each link's `href` and
 * its rendered text, and can fall back to `ExternalProseLink`.
 */
export function Prose({
  text,
  renderLink,
}: {
  text: string;
  renderLink?: (link: ProseLink) => ReactNode;
}) {
  const components = useMemo<Components>(
    () =>
      renderLink
        ? { a: ({ href, children }) => renderLink({ href, children }) }
        : DEFAULT_COMPONENTS,
    [renderLink],
  );
  return (
    <Box
      sx={{
        fontSize: 15,
        lineHeight: 1.75,
        color: "text.primary",
        overflowWrap: "anywhere",
        "& > :first-of-type": { mt: 0 },
        "& > :last-child": { mb: 0 },
        "& p, & ul, & ol, & pre, & blockquote, & table": { m: 0 },
        "& * + p, & * + ul, & * + ol, & * + pre, & * + blockquote, & * + table, & * + h1, & * + h2, & * + h3, & * + h4":
          { mt: 1.5 },
        "& h1, & h2, & h3, & h4, & h5, & h6": {
          mb: 0,
          fontSize: 15,
          fontWeight: 600,
          lineHeight: 1.5,
        },
        "& h1": { fontSize: 17 },
        "& h2": { fontSize: 16 },
        "& ul, & ol": { pl: 2.5 },
        "& li + li": { mt: 0.5 },
        "& li > p": { m: 0 },
        "& a": {
          color: "primary.main",
          textUnderlineOffset: 3,
        },
        "& code": {
          fontFamily: "var(--font-mono)",
          fontSize: "0.86em",
          px: 0.6,
          py: 0.15,
          borderRadius: 0.75,
          backgroundColor: "action.hover",
          overflowWrap: "anywhere",
        },
        "& pre": {
          p: 1.5,
          borderRadius: 1.5,
          backgroundColor: "action.hover",
          overflowX: "auto",
          fontSize: 13,
          lineHeight: 1.6,
        },
        "& pre code": {
          p: 0,
          backgroundColor: "transparent",
          fontSize: "inherit",
          overflowWrap: "normal",
        },
        "& blockquote": {
          pl: 1.5,
          borderLeft: 2,
          borderColor: "divider",
          color: "text.secondary",
        },
        "& table": {
          borderCollapse: "collapse",
          fontSize: 13.5,
          display: "block",
          overflowX: "auto",
        },
        "& th, & td": {
          px: 1,
          py: 0.5,
          border: 1,
          borderColor: "divider",
          textAlign: "left",
        },
        "& hr": { border: 0, borderTop: 1, borderColor: "divider", my: 2 },
      }}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={components}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </Box>
  );
}

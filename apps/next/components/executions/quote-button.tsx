"use client";

/**
 * Floating "Quote" button over a text selection inside agent narration.
 * The quoted text is truncated to what a message can carry, so the quote
 * shown in the message box is exactly what's sent.
 */

import { Button } from "@mui/material";
import FormatQuoteIcon from "@mui/icons-material/FormatQuote";
import { useEffect, useState } from "react";
import { TASK_MESSAGE_QUOTE_TEXT_MAX_LENGTH } from "@scarn/api/frontend-contracts";

export const clampQuoteText = (text: string): string =>
  text.slice(0, TASK_MESSAGE_QUOTE_TEXT_MAX_LENGTH).trim();

export function QuoteButton({ onQuote }: { onQuote: (text: string) => void }) {
  const [selection, setSelection] = useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    const update = () => {
      const current = window.getSelection();
      const text = current?.toString().trim() ?? "";
      if (!current || current.rangeCount === 0 || !text) {
        setSelection(null);
        return;
      }
      const range = current.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const element = node instanceof Element ? node : node.parentElement;
      if (!element?.closest("[data-quotable]")) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setSelection({
        text: clampQuoteText(text),
        top: rect.top - 40,
        left: rect.left + rect.width / 2,
      });
    };
    const clear = () => {
      setSelection(null);
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", clear, true);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", clear, true);
    };
  }, []);

  if (!selection) return null;
  return (
    <Button
      variant="text"
      size="small"
      startIcon={<FormatQuoteIcon sx={{ fontSize: 16 }} />}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        onQuote(selection.text);
        window.getSelection()?.removeAllRanges();
        setSelection(null);
      }}
      sx={{
        position: "fixed",
        top: selection.top,
        left: selection.left,
        transform: "translateX(-50%)",
        zIndex: (theme) => theme.zIndex.tooltip,
        borderRadius: 2,
        px: 1.25,
        py: 0.25,
        minWidth: 0,
        color: "text.primary",
        backgroundColor: "background.paper",
        border: 1,
        borderColor: "divider",
        boxShadow: 8,
        "&:hover": {
          backgroundColor: "background.paper",
          borderColor: "text.disabled",
        },
      }}
    >
      Quote
    </Button>
  );
}

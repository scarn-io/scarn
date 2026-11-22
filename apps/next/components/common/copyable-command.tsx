"use client";

import { useState } from "react";
import { Box, IconButton, Tooltip } from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";

const COPIED_RESET_MS = 2000;

/**
 * Copies `text` to the clipboard and flips `copied` for a moment. A rejected
 * write (no permission, insecure context) leaves the state untouched so the
 * user can still select the text by hand.
 */
export function useCopyToClipboard(): {
  copied: boolean;
  copy: (text: string) => void;
} {
  const [copied, setCopied] = useState(false);

  const copy = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, COPIED_RESET_MS);
      })
      .catch(() => {
        setCopied(false);
      });
  };

  return { copied, copy };
}

/** An inline shell command in a monospace chip with a copy button. */
export function CopyableCommand({ command }: { command: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        maxWidth: "100%",
        pl: 1.25,
        pr: 0.25,
        py: 0.25,
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: "action.hover",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
      }}
    >
      <Box
        component="code"
        sx={{ overflowX: "auto", whiteSpace: "nowrap", fontFamily: "inherit" }}
      >
        {command}
      </Box>
      <Tooltip title={copied ? "Copied" : "Copy"}>
        <IconButton
          aria-label={copied ? "Copied" : `Copy command: ${command}`}
          onClick={() => {
            copy(command);
          }}
          size="small"
        >
          {copied ? (
            <CheckIcon fontSize="inherit" color="success" />
          ) : (
            <ContentCopyIcon fontSize="inherit" />
          )}
        </IconButton>
      </Tooltip>
    </Box>
  );
}

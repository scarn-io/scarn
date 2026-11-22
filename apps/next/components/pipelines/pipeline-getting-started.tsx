"use client";

import {
  Box,
  Button,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import { useCopyToClipboard } from "@/components/common/copyable-command";

const QUICKSTART_URL =
  "https://scarn-io.github.io/scarn/getting-started/quickstart/";

function CommandBlock({
  commands,
  copyLabel,
}: {
  commands: readonly { command: string; note?: string }[];
  copyLabel: string;
}) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <Box
      sx={{
        position: "relative",
        bgcolor: "grey.900",
        color: "grey.100",
        borderRadius: 1,
        p: 2,
        pr: 6,
        textAlign: "left",
        fontFamily: "monospace",
        fontSize: 13,
        lineHeight: 1.9,
        overflowX: "auto",
      }}
    >
      {commands.map(({ command, note }) => (
        <Box key={command} component="div" sx={{ whiteSpace: "pre" }}>
          <Box component="span" sx={{ color: "grey.500", userSelect: "none" }}>
            ${" "}
          </Box>
          {command}
          {note ? (
            <Box
              component="span"
              sx={{ color: "grey.500", userSelect: "none" }}
            >
              {"  "}# {note}
            </Box>
          ) : null}
        </Box>
      ))}
      <Tooltip title={copied ? "Copied" : "Copy all"}>
        <IconButton
          aria-label={copied ? "Copied" : copyLabel}
          onClick={() => {
            copy(commands.map(({ command }) => command).join("\n"));
          }}
          size="small"
          sx={{ position: "absolute", top: 8, right: 8, color: "grey.400" }}
        >
          {copied ? (
            <CheckIcon fontSize="small" color="success" />
          ) : (
            <ContentCopyIcon fontSize="small" />
          )}
        </IconButton>
      </Tooltip>
    </Box>
  );
}

/**
 * Shown in the pipelines empty state. Pipelines are designed with the CLI, so a
 * brand-new project needs the command that gets it there: `scarn init` for a
 * repo that isn't linked yet, `scarn pipelines design` to add a pipeline to
 * one that is. The lower-level scaffold-and-push sequence stays available under
 * "Manual setup", with the project's `owner/slug` ref inlined so it can be
 * copied as-is.
 */
export function PipelineGettingStarted({ projectRef }: { projectRef: string }) {
  const manualCommands = [
    { command: "scarn pipelines init" },
    { command: "cd .scarn/pipeline-builder && npm install" },
    { command: `scarn pipelines push ${projectRef}` },
  ];

  return (
    <Stack spacing={2} sx={{ width: "100%", maxWidth: 560 }}>
      <CommandBlock
        copyLabel="Copy the getting-started commands"
        commands={[
          { command: "scarn init", note: "first time in this repo" },
          {
            command: "scarn pipelines design",
            note: "add another pipeline",
          },
        ]}
      />

      <Box
        component="details"
        sx={{
          textAlign: "left",
          "& > summary": {
            cursor: "pointer",
            color: "text.secondary",
            fontSize: 14,
          },
        }}
      >
        <summary>Manual setup</summary>
        <Box sx={{ pt: 1.5 }}>
          <CommandBlock
            copyLabel="Copy the manual setup commands"
            commands={manualCommands}
          />
        </Box>
      </Box>

      <Typography variant="body2" color="text.secondary">
        Then create a work item and run <code>scarn work {projectRef}</code>{" "}
        to watch it execute. Prefer the browser? Use{" "}
        <strong>New Pipeline</strong> above.
      </Typography>

      <Box>
        <Button
          variant="outlined"
          size="small"
          startIcon={<MenuBookOutlinedIcon />}
          href={QUICKSTART_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open the Quickstart
        </Button>
      </Box>
    </Stack>
  );
}

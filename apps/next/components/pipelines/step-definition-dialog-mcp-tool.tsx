"use client";

/**
 * The read-only view of a `kind: "mcp_tool"` step definition. Tool steps are
 * authored in code (`scarn mcp pull`, then `.step()` on the catalog handle),
 * so the dialog shows what the step calls and has nothing to save.
 */
import type { StepDefinitionContract } from "@scarn/api/frontend-contracts";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import { SectionHeader } from "./step-definition-dialog-sections";

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <Box
      component="pre"
      aria-label={label}
      sx={{
        m: 0,
        p: 1.5,
        maxHeight: 240,
        overflow: "auto",
        bgcolor: "action.hover",
        borderRadius: 1,
        fontFamily: "monospace",
        fontSize: 12,
      }}
    >
      {JSON.stringify(value, null, 2)}
    </Box>
  );
}

function CollapsedJson({ label, value }: { label: string; value: unknown }) {
  return (
    <Box component="details">
      <Typography
        component="summary"
        variant="body2"
        sx={{ cursor: "pointer", mb: 1 }}
      >
        {label}
      </Typography>
      <JsonBlock label={label} value={value} />
    </Box>
  );
}

function Field({ label, children }: { label: string; children: string }) {
  return (
    <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
        {children}
      </Typography>
    </Stack>
  );
}

export function McpToolStepDialog({
  open,
  step,
  onClose,
}: {
  open: boolean;
  step: StepDefinitionContract;
  onClose: () => void;
}) {
  const toolCall = step.toolCallJson;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1} alignItems="center">
          <span>{step.name}</span>
          <Chip label="MCP tool" size="small" variant="outlined" />
        </Stack>
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ pt: 3 }}>
        <Stack spacing={2.5}>
          <Alert severity="info">
            MCP tool steps are authored in code: run <code>scarn mcp pull</code>{" "}
            and declare the step with <code>.step()</code> on the server&apos;s
            handle, then push. This view is read-only.
          </Alert>
          {step.description ? (
            <Typography variant="body2" color="text.secondary">
              {step.description}
            </Typography>
          ) : null}
          <Stack direction="row" spacing={2}>
            <Field label="Key">{step.key}</Field>
            <Field label="Version">{String(step.version)}</Field>
            <Field label="Status">{step.status}</Field>
          </Stack>

          <SectionHeader>Tool call</SectionHeader>
          {toolCall ? (
            <>
              <Stack direction="row" spacing={2}>
                <Field label="Server">{toolCall.server}</Field>
                <Field label="Tool">{toolCall.tool}</Field>
              </Stack>
              <Stack spacing={0.5}>
                <Typography variant="caption" color="text.secondary">
                  Args template
                </Typography>
                <JsonBlock
                  label="Args template"
                  value={toolCall.argsTemplate}
                />
              </Stack>
              <CollapsedJson
                label="Tool input schema"
                value={toolCall.toolSchemas.input}
              />
              {toolCall.toolSchemas.output === null ? (
                <Typography variant="body2" color="text.secondary">
                  The tool declares no output schema.
                </Typography>
              ) : (
                <CollapsedJson
                  label="Tool output schema"
                  value={toolCall.toolSchemas.output}
                />
              )}
            </>
          ) : (
            <Alert severity="warning">This step has no tool call.</Alert>
          )}

          <SectionHeader>Schemas</SectionHeader>
          <CollapsedJson label="Input schema" value={step.inputSchemaJson} />
          <CollapsedJson label="Result schema" value={step.resultSchemaJson} />

          <Stack direction="row" justifyContent="flex-end">
            <Button onClick={onClose}>Close</Button>
          </Stack>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}

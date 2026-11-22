"use client";

import {
  Box,
  Link as MuiLink,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import Link from "next/link";
import { RecordListRow } from "@/components/common/record-list/record-list-row";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import {
  ExecutionStatusIcon,
  getExecutionStatusLabel,
} from "./execution-status-icon";
import { Elapsed } from "./elapsed";
import { formatDateTime, formatRelativeTime } from "./format-datetime";
import { useProjectPath } from "@/components/project-route-context";
import type {
  PipelineDefinitionContract,
  PipelineExecutionSummaryContract,
} from "@scarn/api/frontend-contracts";

export function ExecutionsList({
  executions,
  definitionsById,
  /** Optional origin marker appended to detail links for back navigation. */
  from,
  emptyDescription = "No pipeline executions have been recorded for this work item yet.",
  /** Called when a row is activated (e.g. to close a containing drawer). */
  onNavigate,
}: {
  executions: PipelineExecutionSummaryContract[];
  definitionsById: Map<string, PipelineDefinitionContract>;
  from?: string;
  emptyDescription?: string;
  onNavigate?: () => void;
}) {
  const projectPath = useProjectPath();

  if (executions.length === 0) {
    return (
      <RecordListEmpty title="No executions" description={emptyDescription} />
    );
  }

  return (
    <>
      {executions.map((execution, index) => {
        const definition = definitionsById.get(execution.pipelineDefinitionId);
        const pipelineName = definition?.name ?? null;
        const title = execution.workItemTitle;
        const isRunning = execution.status === "running";
        const query = from ? `?from=${encodeURIComponent(from)}` : "";
        const href = `${projectPath("runs", execution.id)}${query}`;
        // Show the pipeline name as secondary context only when the title comes
        // from the work item (otherwise it would duplicate the title).
        const showPipelineName =
          pipelineName !== null && title !== pipelineName;

        return (
          <RecordListRow
            key={execution.id}
            isFirst={index === 0}
            href={href}
            onNavigate={onNavigate}
            icon={<ExecutionStatusIcon status={execution.status} />}
            primary={
              <Stack
                direction="row"
                spacing={1}
                alignItems="baseline"
                sx={{ minWidth: 0 }}
              >
                <MuiLink
                  component={Link}
                  href={href}
                  onClick={onNavigate}
                  underline="hover"
                  color="inherit"
                  sx={{
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {title}
                </MuiLink>
                {showPipelineName ? (
                  <Typography
                    component="span"
                    variant="caption"
                    color="text.secondary"
                    sx={{ flexShrink: 0 }}
                  >
                    {pipelineName}
                  </Typography>
                ) : null}
              </Stack>
            }
            secondary={
              <Typography
                variant="caption"
                color="text.secondary"
                component="span"
                sx={{ display: "inline-flex", alignItems: "center", gap: 0.75 }}
              >
                <Box component="span">
                  {getExecutionStatusLabel(execution.status)}
                </Box>
                <Box component="span" aria-hidden>
                  ·
                </Box>
                <Tooltip title={formatDateTime(execution.createdAt)}>
                  <Box component="span">
                    opened {formatRelativeTime(execution.createdAt)}
                  </Box>
                </Tooltip>
                {isRunning && execution.openNodeIds.length > 0 ? (
                  <>
                    <Box component="span" aria-hidden>
                      ·
                    </Box>
                    <Box
                      component="span"
                      sx={{ fontFamily: "var(--font-mono)" }}
                    >
                      {execution.openNodeIds.join(", ")}
                    </Box>
                  </>
                ) : null}
              </Typography>
            }
            trailing={
              <Stack direction="row" spacing={1.5} alignItems="center">
                {execution.startedAt ? (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 0.5,
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    <AccessTimeIcon sx={{ fontSize: 14 }} />
                    <Elapsed
                      startedAt={execution.startedAt}
                      completedAt={execution.completedAt}
                      endedAt={execution.updatedAt}
                      isRunning={isRunning}
                    />
                  </Typography>
                ) : null}
              </Stack>
            }
          />
        );
      })}
    </>
  );
}

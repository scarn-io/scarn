"use client";

/**
 * A conversation in a sheet over the page that owns it (the work item page):
 * the same chat as the step page, with its actions in the header's ⋯ menu.
 * From `md` up it is a 520px side sheet over a light backdrop, resizable by
 * dragging its left edge and widened from the header; below `md` it covers
 * the screen like a pushed page and follows `window.visualViewport`, so the
 * composer stays above the on-screen keyboard.
 */

import { Alert, Box, Drawer, useMediaQuery } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { parseApiError } from "@/app/_lib/api-error";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import { DrawerResizeHandle } from "@/components/common/right-drawer";
import { useResizableWidth } from "@/components/common/use-resizable-width";
import { useVisualViewport } from "@/components/common/use-visual-viewport";
import {
  buildSelectionHref,
  buildStepPageHref,
} from "@/components/executions/execution-detail-params";
import { useProjectPath } from "@/components/project-route-context";
import {
  ConversationMessageBox,
  ConversationPanel,
  DEFAULT_AGENT_NAME,
} from "./conversation-panel";
import { ConversationScroller } from "./conversation-scroller";
import { ConversationSheetHeader } from "./conversation-sheet-header";
import {
  useConversation,
  type ConversationActionOutcome,
  type ConversationData,
} from "./use-conversation";

export const SHEET_WIDTH = 520;
export const SHEET_WIDE_WIDTH = 880;
const SHEET_MIN_WIDTH = 400;
const COLUMN_MAX_WIDTH = 680;

const splitHref = (href: string): [string, URLSearchParams] => {
  const [path = "", query = ""] = href.split("?");
  return [path, new URLSearchParams(query)];
};

/**
 * Where the conversation's run lives: its step visit on the step page, or
 * the Task when the conversation has no visit (an ad hoc agent Task).
 */
function useRunLinks(
  data: ConversationData,
  taskId: string | null,
): { runHref: string | null; logsHref: (taskRunId: string) => string } {
  const projectPath = useProjectPath();
  const visit = data.conversation?.visit ?? null;
  if (visit === null) {
    return {
      runHref: taskId === null ? null : projectPath("runs", "tasks", taskId),
      logsHref: (taskRunId) => projectPath("runs", "tasks", taskRunId),
    };
  }
  const runHref = buildSelectionHref(
    projectPath("runs", visit.pipelineExecutionId),
    new URLSearchParams(),
    { kind: "step", nodeId: visit.nodeId, visitId: visit.visitId },
  );
  const [path, params] = splitHref(runHref);
  return {
    runHref,
    logsHref: () => buildStepPageHref(path, params, { view: "logs" }),
  };
}

/** Holds the last id it was given, so the sheet keeps its content while it slides out. */
function useLastConversationId(conversationId: string | null): string | null {
  const [last, setLast] = useState(conversationId);
  if (conversationId !== null && conversationId !== last) {
    setLast(conversationId);
  }
  return conversationId ?? last;
}

export function ConversationSheet({
  conversationId,
  agentName = DEFAULT_AGENT_NAME,
  workItemTitle,
  taskId = null,
  onClose,
  onChanged,
}: {
  /** The conversation to show; null closes the sheet. */
  conversationId: string | null;
  agentName?: string;
  workItemTitle: string;
  /** The agent Task to **Stop**; null hides Stop. */
  taskId?: string | null;
  onClose: () => void;
  /** Runs after an action succeeds, so the page behind catches up. */
  onChanged?: () => void;
}) {
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("md"));
  const viewport = useVisualViewport();
  const router = useRouter();
  const shownId = useLastConversationId(conversationId);
  const data = useConversation(shownId, { onChanged });
  const { runHref, logsHref } = useRunLinks(data, taskId);
  const { width, setWidth, startDragging } = useResizableWidth({
    initialWidth: SHEET_WIDTH,
    minWidth: SHEET_MIN_WIDTH,
  });
  const [actionError, setActionError] = useState("");
  const wide = width > SHEET_WIDTH;

  const report = (outcome: ConversationActionOutcome) => {
    setActionError(outcome.ok ? "" : outcome.error);
  };

  const stop =
    taskId === null
      ? null
      : async () => {
          setActionError("");
          try {
            await unwrapTreatyResponse(
              getBrowserScarnApiClient()
                .api.tasks({ taskId: parseUuidV7(taskId) })
                .cancel.post(),
            );
            onChanged?.();
          } catch (stopError) {
            setActionError(
              parseApiError(stopError, "Could not stop the task. Try again."),
            );
          }
        };

  return (
    <Drawer
      anchor="right"
      data-testid="conversation-sheet"
      data-layout={mobile ? "full" : "side"}
      open={conversationId !== null}
      onClose={onClose}
      slotProps={{
        backdrop: {
          sx: { backgroundColor: mobile ? "transparent" : "rgba(0,0,0,0.12)" },
        },
        paper: {
          sx: mobile
            ? {
                width: "100%",
                height: viewport.height,
                top: viewport.top,
                display: "flex",
                flexDirection: "column",
              }
            : {
                width,
                maxWidth: "100vw",
                display: "flex",
                flexDirection: "column",
              },
        },
      }}
    >
      {mobile ? null : (
        <DrawerResizeHandle onPointerDown={startDragging} from="md" />
      )}
      <ConversationSheetHeader
        data={data}
        agentName={agentName}
        workItemTitle={workItemTitle}
        mobile={mobile}
        wide={wide}
        onToggleWide={() => {
          setWidth(wide ? SHEET_WIDTH : SHEET_WIDE_WIDTH);
        }}
        onClose={onClose}
        runHref={runHref}
        onStop={stop}
        onOutcome={report}
      />
      <ConversationScroller
        data={data}
        px={2}
        testId="conversation-sheet-scroller"
      >
        <Box sx={{ maxWidth: COLUMN_MAX_WIDTH, mx: "auto", py: 2.5 }}>
          <ConversationPanel
            data={data}
            agentName={agentName}
            showActions={false}
            onShowWork={(taskRunId) => {
              router.push(logsHref(taskRunId));
            }}
          />
          {actionError ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              {actionError}
            </Alert>
          ) : null}
        </Box>
      </ConversationScroller>
      <Box sx={{ flexShrink: 0, px: 2 }}>
        <Box sx={{ maxWidth: COLUMN_MAX_WIDTH, mx: "auto" }}>
          <ConversationMessageBox
            data={data}
            agentName={agentName}
            autoFocus={!mobile}
          />
        </Box>
      </Box>
    </Drawer>
  );
}

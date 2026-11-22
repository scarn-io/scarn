"use client";

/** A repo conversation's (chat's) status line, and why its reply box is closed, by its `state`. */

import { Box, Stack, Typography } from "@mui/material";
import type { ConversationContract } from "@scarn/api/frontend-contracts";
import { ThinkingIndicator } from "@/components/executions/conversation-parts";
import { SystemLine } from "@/components/executions/thread-parts";
import { AgentAvatar } from "./conversation-messages";

export function ChatStatusLine({
  conversation,
  agentName,
}: {
  conversation: ConversationContract;
  agentName: string;
}) {
  switch (conversation.state) {
    case "queued":
      return (
        <SystemLine icon="…">
          Queued — waiting for a worker to pick it up.
        </SystemLine>
      );
    case "retry_queued":
      return (
        <SystemLine icon="↻">Retry queued — waiting for a worker.</SystemLine>
      );
    case "running":
      return (
        <Stack direction="row" spacing={1.25} alignItems="center">
          <AgentAvatar agentName={agentName} />
          <Box sx={{ ml: -1.5 }}>
            <ThinkingIndicator label={`${agentName} is working…`} />
          </Box>
        </Stack>
      );
    case "waiting":
      return (
        <Typography variant="body2" sx={{ color: "warning.main" }}>
          Waiting for a reply
        </Typography>
      );
    case "ended":
      return <SystemLine icon="✓">This conversation has ended.</SystemLine>;
    case "failed":
    case undefined:
      return null;
  }
}

/** Why a chat's reply box is closed; null while it takes a reply. */
export function chatReplyBlockedReason(
  conversation: ConversationContract | null,
): string | null {
  if (!conversation?.state) return null;
  if (!conversation.capabilities?.canReply) {
    return "Only project members can reply";
  }
  switch (conversation.state) {
    case "waiting":
      return null;
    case "failed":
      return "Retry to continue";
    case "ended":
      return "This conversation has ended";
    case "queued":
    case "running":
    case "retry_queued":
      return "The agent is working…";
  }
}

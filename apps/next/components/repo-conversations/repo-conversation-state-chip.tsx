/** A chat's derived state as a chip with a readable label. */
import { Chip, type ChipProps } from "@mui/material";
import {
  REPO_CONVERSATION_STATE_LABELS,
  type RepoConversationState,
} from "./repo-conversation-api";

const STATE_COLORS: Record<RepoConversationState, ChipProps["color"]> = {
  queued: "default",
  running: "info",
  retry_queued: "default",
  waiting: "warning",
  failed: "error",
  ended: "default",
};

export function RepoConversationStateChip({
  state,
}: {
  state: RepoConversationState;
}) {
  return (
    <Chip
      size="small"
      variant="outlined"
      color={STATE_COLORS[state]}
      label={REPO_CONVERSATION_STATE_LABELS[state]}
    />
  );
}

export const MAX_AGENT_MESSAGE_LENGTH = 10_000;
export const AGENT_MESSAGE_CUT_SUFFIX = "…(cut to 10,000 characters)";

/**
 * The body an agent's hand-over message is posted with: trimmed, and cut to
 * `MAX_AGENT_MESSAGE_LENGTH` with `AGENT_MESSAGE_CUT_SUFFIX`. `length` is the
 * trimmed message's, so a caller can tell whether it was cut.
 */
export const agentMessageBody = (
  message: string,
): { body: string; length: number } => {
  const trimmed = message.trim();
  const body =
    trimmed.length <= MAX_AGENT_MESSAGE_LENGTH
      ? trimmed
      : `${trimmed.slice(0, MAX_AGENT_MESSAGE_LENGTH - AGENT_MESSAGE_CUT_SUFFIX.length).trimEnd()}${AGENT_MESSAGE_CUT_SUFFIX}`;
  return { body, length: trimmed.length };
};

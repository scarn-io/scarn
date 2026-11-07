import type {
  SessionMessageInfo,
  SessionStructuredError,
} from "@opencode/client";

/**
 * Reading why an OpenCode session turn failed: an assistant step that
 * errored, or an idle marker whose execution failed (e.g. an unknown agent,
 * which never produces an assistant message at all).
 *
 * `aborted` assistant errors and `interrupted` idle markers are not failures
 * of the turn itself: the worker interrupts sessions on its own (timeouts,
 * cancellation), and those paths report their own cause.
 */

export function describeStructuredError(error: SessionStructuredError): string {
  return `${error.type}: ${error.message}`;
}

export function sessionErrorOf(
  message: SessionMessageInfo,
): SessionStructuredError | undefined {
  if (
    message.type === "assistant" &&
    message.error &&
    message.error.type !== "aborted"
  ) {
    return message.error;
  }
  if (message.type === "idle" && message.outcome === "failed") {
    return (
      message.error ?? {
        type: "unknown",
        message: "The session execution failed",
      }
    );
  }
  return undefined;
}

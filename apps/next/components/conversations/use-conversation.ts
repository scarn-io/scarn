"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { apiErrorStatus, parseApiError } from "@/app/_lib/api-error";
import { isPageHidden } from "@/components/use-defer-while-hidden";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  conversationSchema,
  parseUuidV7,
  type ConversationContract,
  type RepoConversationState,
} from "@scarn/api/frontend-contracts";

/** How often the panel re-reads the conversation while the agent has the floor. */
export const CONVERSATION_POLL_INTERVAL_MS = 5000;

const POLLING_STATUSES = new Set<ConversationContract["status"]>([
  "agent_turn",
  "reply_pending",
]);

/** How often a chat re-reads itself while a turn is queued or running, and otherwise. */
export const CHAT_POLL_INTERVALS_MS = { active: 5000, idle: 30_000 };

const ACTIVE_CHAT_STATES = new Set<RepoConversationState>([
  "queued",
  "running",
  "retry_queued",
]);

export type ConversationActionOutcome =
  { ok: true } | { ok: false; error: string; status?: number };

export type ConversationAction =
  "send" | "continue" | "done" | "retry-turn" | "end" | "delete";

/**
 * A message the viewer sent that the conversation doesn't hold yet: shown
 * straight away while it sends, and kept with a retry when the send fails.
 */
export type LocalConversationMessage = {
  localId: string;
  body: string;
  createdAt: string;
  delivery: "sending" | "failed";
  /** Why the last send failed. */
  error: string | null;
};

export type ConversationData = {
  conversation: ConversationContract | null;
  /** True until the first read of this conversation settles. */
  loading: boolean;
  error: string;
  /** The last read was refused (403) or found nothing (404); the transcript is cleared. */
  unavailable: boolean;
  /** The action in flight, if any. */
  pending: ConversationAction | null;
  /** The viewer's messages still sending, or failed, after the conversation's own. */
  localMessages: LocalConversationMessage[];
  send: (body: string) => Promise<ConversationActionOutcome>;
  /** Sends a failed local message again. */
  retry: (localId: string) => Promise<ConversationActionOutcome>;
  continueWithoutReply: () => Promise<ConversationActionOutcome>;
  done: () => Promise<ConversationActionOutcome>;
  /** Chats: starts a fresh run of a failed turn, if `expectedLatestRunId` is still the latest. */
  retryTurn: (
    expectedLatestRunId: string | null,
  ) => Promise<ConversationActionOutcome>;
  /** Chats: ends the chat; it stays readable. */
  end: () => Promise<ConversationActionOutcome>;
  /** Chats: deletes the chat. */
  remove: () => Promise<ConversationActionOutcome>;
  /** Reads the conversation again now. */
  refetch: () => void;
};

let localMessageCounter = 0;

/**
 * Reads a conversation from `GET /conversations/:id` and runs its actions;
 * a `null` id reads nothing.
 * Polls while the agent has the floor (`agent_turn`, `reply_pending`) and
 * re-reads whenever `refreshKey` changes (the execution poll saw the visit
 * move). A chat (one with a `state`) polls always instead: every
 * `chatPollIntervalsMs.active` while a turn is queued or running, every
 * `.idle` otherwise. Every poll is skipped while the tab is hidden. A chat
 * re-reads on window focus and when the tab becomes visible; any other
 * polling conversation re-reads then only if it skipped a poll while hidden.
 * A 403 or 404 drops what was read (`unavailable`). `onChanged` runs after an
 * action succeeds, so the run view catches
 * up with the turn or step it started. A sent message shows at once as a
 * local message until the response carries it; a failed one stays, marked
 * failed, until `retry` delivers it.
 */
export function useConversation(
  conversationId: string | null,
  {
    refreshKey = null,
    onChanged,
    pollIntervalMs = CONVERSATION_POLL_INTERVAL_MS,
    chatPollIntervalsMs = CHAT_POLL_INTERVALS_MS,
  }: {
    refreshKey?: string | null;
    onChanged?: () => void;
    pollIntervalMs?: number;
    chatPollIntervalsMs?: { active: number; idle: number };
  } = {},
): ConversationData {
  const apiClient = useMemo(() => getBrowserScarnApiClient(), []);
  const [loaded, setLoaded] = useState<{
    id: string;
    conversation: ConversationContract | null;
    error: string;
    unavailable?: boolean;
  } | null>(null);
  const [pending, setPending] = useState<ConversationAction | null>(null);
  const [pollNonce, setPollNonce] = useState(0);
  const [localMessages, setLocalMessages] = useState<
    (LocalConversationMessage & { conversationId: string | null })[]
  >([]);

  const route = useCallback(() => {
    if (conversationId === null) throw new Error("No conversation to read");
    return apiClient.api.conversations({
      conversationId: parseUuidV7(conversationId),
    });
  }, [apiClient, conversationId]);

  const accept = useCallback(
    // eslint-disable-next-line local/no-unknown-parameter-type
    (data: unknown): ConversationContract | null => {
      const parsed = conversationSchema.safeParse(data);
      if (!parsed.success || conversationId === null) return null;
      setLoaded({ id: conversationId, conversation: parsed.data, error: "" });
      return parsed.data;
    },
    [conversationId],
  );

  useEffect(() => {
    if (conversationId === null) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await unwrapTreatyResponse(route().get());
        if (controller.signal.aborted) return;
        if (!accept(data)) {
          setLoaded({
            id: conversationId,
            conversation: null,
            error: "Received invalid conversation payload",
          });
        }
      } catch (loadError) {
        if (controller.signal.aborted) return;
        const status = apiErrorStatus(loadError);
        if (status === 403 || status === 404) {
          setLoaded({
            id: conversationId,
            conversation: null,
            error:
              status === 404
                ? "This conversation doesn't exist, or it was deleted."
                : "You don't have access to this conversation.",
            unavailable: true,
          });
          setLocalMessages((messages) =>
            messages.filter(
              (message) => message.conversationId !== conversationId,
            ),
          );
          return;
        }
        setLoaded((current) => ({
          id: conversationId,
          conversation:
            current?.id === conversationId ? current.conversation : null,
          error: parseApiError(loadError, "Failed to load the conversation"),
        }));
      }
    };
    void load();
    return () => {
      controller.abort();
    };
  }, [route, accept, conversationId, refreshKey, pollNonce]);

  const current =
    conversationId !== null && loaded?.id === conversationId ? loaded : null;
  const status = current?.conversation?.status ?? null;
  const chatState = current?.conversation?.state ?? null;
  const isChat = chatState !== null;
  const interval =
    chatState !== null
      ? ACTIVE_CHAT_STATES.has(chatState)
        ? chatPollIntervalsMs.active
        : chatPollIntervalsMs.idle
      : status !== null && POLLING_STATUSES.has(status)
        ? pollIntervalMs
        : null;

  const refetch = useCallback(() => {
    setPollNonce((nonce) => nonce + 1);
  }, []);

  const refreshOwed = useRef(false);

  useEffect(() => {
    if (interval === null) return;
    const timeoutId = setTimeout(() => {
      if (isPageHidden()) {
        refreshOwed.current = true;
        return;
      }
      refetch();
    }, interval);
    return () => {
      clearTimeout(timeoutId);
    };
  }, [interval, current, refetch]);

  const listening = interval !== null;
  useEffect(() => {
    if (!listening) return;
    const onVisible = () => {
      if (isPageHidden() || (!isChat && !refreshOwed.current)) return;
      refreshOwed.current = false;
      refetch();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [listening, isChat, refetch]);

  const run = useCallback(
    async (
      action: ConversationAction,
      fallbackError: string,
      request: () => Promise<unknown>,
      settle?: (outcome: ConversationActionOutcome) => void,
    ): Promise<ConversationActionOutcome> => {
      setPending(action);
      let outcome: ConversationActionOutcome;
      try {
        accept(await request());
        outcome = { ok: true };
      } catch (actionError) {
        const status = apiErrorStatus(actionError);
        outcome = {
          ok: false,
          error: parseApiError(actionError, fallbackError),
          ...(status === undefined ? {} : { status }),
        };
      }
      settle?.(outcome);
      setPending(null);
      if (outcome.ok) onChanged?.();
      return outcome;
    },
    [accept, onChanged],
  );

  const deliver = useCallback(
    (localId: string, body: string) =>
      run(
        "send",
        "Failed to send the message",
        () => unwrapTreatyResponse(route().messages.post({ body })),
        (outcome) => {
          setLocalMessages((messages) =>
            outcome.ok
              ? messages.filter((message) => message.localId !== localId)
              : messages.map((message) =>
                  message.localId === localId
                    ? {
                        ...message,
                        delivery: "failed" as const,
                        error: outcome.error,
                      }
                    : message,
                ),
          );
        },
      ),
    [run, route],
  );

  const send = useCallback(
    (body: string) => {
      localMessageCounter += 1;
      const localId = `local-${String(localMessageCounter)}`;
      setLocalMessages((messages) => [
        ...messages,
        {
          conversationId,
          localId,
          body,
          createdAt: new Date().toISOString(),
          delivery: "sending",
          error: null,
        },
      ]);
      return deliver(localId, body);
    },
    [deliver, conversationId],
  );

  const retry = useCallback(
    (localId: string) => {
      const message = localMessages.find(
        (candidate) => candidate.localId === localId,
      );
      if (!message) {
        return Promise.resolve<ConversationActionOutcome>({
          ok: false,
          error: "That message is no longer here",
        });
      }
      setLocalMessages((messages) =>
        messages.map((candidate) =>
          candidate.localId === localId
            ? { ...candidate, delivery: "sending" as const, error: null }
            : candidate,
        ),
      );
      return deliver(localId, message.body);
    },
    [deliver, localMessages],
  );
  const continueWithoutReply = useCallback(
    () =>
      run("continue", "Failed to continue without a reply", () =>
        unwrapTreatyResponse(route().continue.post()),
      ),
    [run, route],
  );
  const done = useCallback(
    () =>
      run("done", "Failed to end the conversation", () =>
        unwrapTreatyResponse(route().done.post()),
      ),
    [run, route],
  );
  const retryTurn = useCallback(
    (expectedLatestRunId: string | null) =>
      run("retry-turn", "Failed to retry", () =>
        unwrapTreatyResponse(
          route().retry.post({
            expectedLatestRunId:
              expectedLatestRunId === null
                ? null
                : parseUuidV7(expectedLatestRunId),
          }),
        ),
      ),
    [run, route],
  );
  const end = useCallback(
    () =>
      run("end", "Failed to end the conversation", () =>
        unwrapTreatyResponse(route().end.post()),
      ),
    [run, route],
  );
  const remove = useCallback(
    () =>
      run("delete", "Failed to delete the conversation", () =>
        unwrapTreatyResponse(route().delete()),
      ),
    [run, route],
  );

  return {
    conversation: current?.conversation ?? null,
    loading: conversationId !== null && current === null,
    error: current?.error ?? "",
    unavailable: current?.unavailable ?? false,
    pending,
    localMessages: localMessages.flatMap(
      ({ conversationId: owner, ...message }) =>
        owner === conversationId ? [message] : [],
    ),
    send,
    retry,
    continueWithoutReply,
    done,
    retryTurn,
    end,
    remove,
    refetch,
  };
}

"use client";

/**
 * Browser fetchers for a Task's grant requests (its agent asking for more
 * access): reading a Task's requests, finding the one an agent message
 * carries, and deciding one. Also says whether a conversation waits on a
 * pending request.
 */
import { useEffect, useState } from "react";
import type { GrantRequestContract } from "@scarn/core/tasks/grant-request/contracts/grant-request-contracts";
import type { Grant } from "@scarn/core/tasks/task/domain/grants";
import {
  parseUuidV7,
  type ConversationContract,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";

export type GrantRequest = GrantRequestContract;

export type GrantRequestDecisionOutcome =
  { ok: true } | { ok: false; error: string };

/** A Task's grant requests, oldest first. */
export async function fetchTaskGrantRequests(
  taskId: string,
): Promise<GrantRequest[]> {
  return await unwrapTreatyResponse(
    getBrowserScarnApiClient()
      .api.tasks({ taskId: parseUuidV7(taskId) })
      ["grant-requests"].get(),
  );
}

/** The Task a run belongs to. */
async function fetchTaskIdOfRun(taskRunId: string): Promise<string> {
  const run = await unwrapTreatyResponse(
    getBrowserScarnApiClient()
      .api["task-runs"]({ taskRunId: parseUuidV7(taskRunId) })
      .get(),
  );
  return run.taskId;
}

/** Approves `approved` (`[]` denies), resuming the Task. */
export async function decideGrantRequest(
  grantRequestId: string,
  approved: Grant[],
  note: string,
): Promise<GrantRequestDecisionOutcome> {
  try {
    await unwrapTreatyResponse(
      getBrowserScarnApiClient()
        .api["task-grant-requests"]({
          grantRequestId: parseUuidV7(grantRequestId),
        })
        .decision.post({
          approved,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: parseApiError(error, "Could not record the decision. Try again."),
    };
  }
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; request: GrantRequest };

/**
 * The grant request `grantRequestId`, found through the run that wrote the
 * agent message. Re-reads whenever `refreshKey` changes.
 */
export function useGrantRequest(
  grantRequestId: string,
  taskRunId: string | null,
  refreshKey: string,
): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (taskRunId === null) {
      setState({ status: "error", message: "This request can't be read." });
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const taskId = await fetchTaskIdOfRun(taskRunId);
        const requests = await fetchTaskGrantRequests(taskId);
        if (cancelled) return;
        const request = requests.find(
          (candidate) => candidate.id === grantRequestId,
        );
        setState(
          request
            ? { status: "ready", request }
            : { status: "error", message: "This request no longer exists." },
        );
      } catch (error) {
        if (cancelled) return;
        setState((prev) =>
          prev.status === "ready"
            ? prev
            : {
                status: "error",
                message: parseApiError(error, "Could not load the request."),
              },
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [grantRequestId, taskRunId, refreshKey]);

  return state;
}

/**
 * The grant request the conversation waits on: the newest agent message
 * carries one, the agent waits, and no decision was recorded. Null otherwise.
 */
export function pendingGrantRequestId(
  conversation: Pick<ConversationContract, "status" | "messages"> | null,
): string | null {
  if (conversation?.status !== "waiting_for_person") return null;
  const lastAgent = conversation.messages
    .filter((message) => message.authorKind === "agent")
    .at(-1);
  const id = lastAgent?.grantRequestId ?? null;
  if (id === null) return null;
  const decided = conversation.messages.some(
    (message) =>
      message.authorKind === "system" && message.grantRequestId === id,
  );
  return decided ? null : id;
}

/** What an agent message carrying a grant request needs to show its card. */
export type GrantRequestCardContext = {
  /** Changes with the conversation, so the request is read again. */
  refreshKey: string;
  /** Who decided it, as its decision's system message names them. */
  decidedBy: string | null;
  onDecided: () => void;
};

/** The card context for `grantRequestId`; null for a message without one. */
export function grantRequestCardContext(
  conversation: Pick<ConversationContract, "status" | "messages">,
  grantRequestId: string | null | undefined,
  onDecided: () => void,
): GrantRequestCardContext | null {
  if (!grantRequestId) return null;
  const decision = conversation.messages.find(
    (message) =>
      message.authorKind === "system" &&
      message.grantRequestId === grantRequestId,
  );
  return {
    refreshKey: `${conversation.status}:${String(conversation.messages.length)}`,
    decidedBy: decision?.authorName ?? null,
    onDecided,
  };
}

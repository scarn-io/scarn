"use client";

import { Snackbar } from "@mui/material";
import { useState, type ReactNode } from "react";
import { notifyInboxChanged } from "@/components/inbox/inbox-api";
import { useHasProjectPermission } from "@/components/project-route-context";
import type { ProjectRun } from "@/components/runs/runs-api";

/** Who an open wait waits on, from the run's Runs-list row. */
export type WaitWaiters = {
  /** True when the run waits on the viewer in particular. */
  waitingOnYou: boolean;
  /** The usernames it waits on; empty when unknown. */
  names: string[];
};

/**
 * What a wait pane can do. Each action is `null` when the viewer lacks the
 * permission, and resolves whether it went through; on success it shows
 * `confirmation` and tells the inbox to re-read.
 */
export type WaitControls = {
  /** `null` until the run row loads. */
  waiters: WaitWaiters | null;
  /** The pinned pipeline document, for where each choice goes next. */
  definition: Record<string, unknown> | null;
  pending: boolean;
  decide:
    | ((
        visitId: string,
        action: string,
        body: string,
        confirmation: string,
      ) => Promise<boolean>)
    | null;
  answer:
    | ((
        questionId: string,
        body: string,
        confirmation: string,
      ) => Promise<boolean>)
    | null;
  continueWithoutReply:
    ((questionId: string, confirmation: string) => Promise<boolean>) | null;
};

type WaitMutations = {
  decideVisit: (
    visitId: string,
    action: string,
    body?: string,
  ) => Promise<boolean>;
  answerQuestion: (questionId: string, body: string) => Promise<boolean>;
  continueWithoutReply: (questionId: string) => Promise<boolean>;
};

function waitersOf(run: ProjectRun | null): WaitWaiters | null {
  if (!run) return null;
  return {
    waitingOnYou: run.waitingOnYou,
    names: run.waitingOn.flatMap((person) =>
      person.username ? [person.username] : [],
    ),
  };
}

/**
 * The wait pane's actions, gated by permission, and the Snackbar that
 * confirms them. Render `toast` once on the page so it outlives the pane.
 */
export function useWaitControls({
  run,
  definition,
  pending,
  mutations,
}: {
  run: ProjectRun | null;
  definition: Record<string, unknown> | null;
  pending: boolean;
  mutations: WaitMutations;
}): { controls: WaitControls; toast: ReactNode } {
  const canWriteExecutions = useHasProjectPermission("executions:write");
  const canCreateComments = useHasProjectPermission("comments:write");
  const [message, setMessage] = useState<string | null>(null);

  const confirmed = async (
    done: Promise<boolean>,
    confirmation: string,
  ): Promise<boolean> => {
    const ok = await done;
    if (ok) {
      setMessage(confirmation);
      notifyInboxChanged();
    }
    return ok;
  };

  const controls: WaitControls = {
    waiters: waitersOf(run),
    definition,
    pending,
    decide: canWriteExecutions
      ? (visitId, action, body, confirmation) =>
          confirmed(
            mutations.decideVisit(visitId, action, body || undefined),
            confirmation,
          )
      : null,
    answer: canCreateComments
      ? (questionId, body, confirmation) =>
          confirmed(mutations.answerQuestion(questionId, body), confirmation)
      : null,
    continueWithoutReply: canWriteExecutions
      ? (questionId, confirmation) =>
          confirmed(mutations.continueWithoutReply(questionId), confirmation)
      : null,
  };

  const toast = (
    <Snackbar
      open={message !== null}
      autoHideDuration={4000}
      message={message}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      onClose={(_event, reason) => {
        if (reason !== "clickaway") setMessage(null);
      }}
    />
  );

  return { controls, toast };
}

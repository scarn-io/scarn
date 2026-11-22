"use client";

import { Box, Link as MuiLink, Stack, Typography } from "@mui/material";
import Link from "next/link";
import type { ReactNode } from "react";
import type { NodeVisitContract } from "@scarn/api/frontend-contracts";
import { useProjectPath } from "@/components/project-route-context";
import {
  isAwaitingDecision,
  isAwaitingReply,
} from "./execution-step-action-guards";
import { formatDateTime } from "./format-datetime";
import { JsonBlock } from "./json-block";
import { TextLink } from "./thread-parts";
import { useQuestionBodies } from "./use-question-bodies";
import type { WaitControls, WaitWaiters } from "./use-wait-controls";
import { Mono, WaitAnswerBox, type WaitAsk } from "./wait-answer-box";
import { waitNodeInfo } from "./wait-targets";

type WaitResult = { action: unknown; replied: unknown; body: unknown };

function readResult(result: NodeVisitContract["result"]): WaitResult | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const { action, replied, body } = result;
  return { action, replied, body };
}

function PaneFrame({
  eyebrow,
  open,
  children,
}: {
  eyebrow: string;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <Box sx={{ maxWidth: 720, mx: "auto", width: "100%" }}>
      <Typography
        variant="caption"
        component="p"
        sx={{
          mb: 1,
          color: open ? "warning.main" : "text.disabled",
          fontWeight: open ? 600 : 400,
        }}
      >
        {eyebrow}
      </Typography>
      {children}
    </Box>
  );
}

function Quote({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <Box
      sx={{
        pl: 2,
        borderLeft: 2,
        borderColor: open ? "warning.main" : "divider",
        mb: 2.5,
      }}
    >
      {children}
    </Box>
  );
}

function waitersLine(waiters: WaitWaiters | null): string | null {
  if (!waiters || waiters.waitingOnYou) return null;
  const who =
    waiters.names.length > 0 ? waiters.names.join(", ") : "someone else";
  return `Waiting on ${who} — you can still answer`;
}

function eyebrowOf(
  visit: NodeVisitContract,
  open: boolean,
  waiters: WaitWaiters | null,
): string {
  const decision = visit.waitFor !== "reply";
  if (!open) return decision ? "Decision" : "Reply wait";
  if (waiters?.waitingOnYou) return decision ? "Your decision" : "Your reply";
  return decision ? "Waiting for a decision" : "Waiting for reply";
}

function Resolution({ visit }: { visit: NodeVisitContract }) {
  const result = readResult(visit.result);
  const body = typeof result?.body === "string" ? result.body : null;
  let outcome: string | null = null;
  const action = result?.action;
  if (typeof action === "string") {
    outcome =
      visit.actions?.find((candidate) => candidate.key === action)?.label ??
      action;
  } else if (typeof result?.replied === "boolean") {
    outcome = result.replied ? "Replied" : "Continued without a reply";
  }
  return (
    <Box>
      <Typography variant="subtitle2">
        {outcome ? (
          <Box component="span" sx={{ color: "success.main", mr: 0.75 }}>
            ✓
          </Box>
        ) : null}
        {outcome ??
          (visit.status === "superseded"
            ? "Replaced by a later rerun"
            : "Not resolved")}
      </Typography>
      {visit.resolvedAt ? (
        <Typography variant="caption" color="text.secondary">
          {formatDateTime(visit.resolvedAt)}
        </Typography>
      ) : null}
      {body ? (
        <Typography variant="body2" sx={{ mt: 1, whiteSpace: "pre-wrap" }}>
          {body}
        </Typography>
      ) : null}
    </Box>
  );
}

/**
 * A wait node's step page: the question as a quote, then an answer box while
 * it waits — one button per decision action naming where it goes next, or a
 * reply box with Continue without reply. When the run waits on someone else
 * it says who; the viewer can still answer if they have the permission.
 */
export function WaitVisitPanel({
  visit,
  workItemId,
  controls,
  onOpenDetails,
}: {
  visit: NodeVisitContract;
  workItemId: string;
  controls: WaitControls;
  onOpenDetails: () => void;
}) {
  const projectPath = useProjectPath();
  const bodies = useQuestionBodies(
    workItemId,
    visit.questions.map((question) => question.commentId),
  );
  const node = waitNodeInfo(controls.definition, visit.nodeId);
  const isReply = visit.waitFor === "reply";
  const open = isReply ? isAwaitingReply(visit) : isAwaitingDecision(visit);
  const openQuestion = visit.questions.find(
    (question) => question.status === "open",
  );
  const replyTo = node.targetOf();

  const ask: WaitAsk | null = !open
    ? null
    : isReply
      ? openQuestion && (controls.answer || controls.continueWithoutReply)
        ? {
            kind: "reply",
            to: replyTo,
            onAnswer: controls.answer
              ? (body) =>
                  controls.answer?.(
                    openQuestion.questionId,
                    body,
                    replyTo
                      ? `Answer sent — the run goes on to ${replyTo}`
                      : "Answer sent",
                  ) ?? Promise.resolve(false)
              : null,
            onContinue: controls.continueWithoutReply
              ? () =>
                  controls.continueWithoutReply?.(
                    openQuestion.questionId,
                    "Continued without a reply",
                  ) ?? Promise.resolve(false)
              : null,
          }
        : null
      : controls.decide
        ? {
            kind: "decision",
            choices: (visit.actions ?? []).map((action) => ({
              key: action.key,
              label: action.label,
              notesRequired: action.body === "required",
              to: node.targetOf(action.key),
            })),
            onDecide: (choice, notes) =>
              controls.decide?.(
                visit.id,
                choice.key,
                notes,
                choice.to
                  ? `${choice.label} — the run goes on to ${choice.to}`
                  : `${choice.label} recorded`,
              ) ?? Promise.resolve(false),
          }
        : null;

  const waitingOn = open && ask ? waitersLine(controls.waiters) : null;

  return (
    <PaneFrame eyebrow={eyebrowOf(visit, open, controls.waiters)} open={open}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        {isReply ? (
          <>
            The run asked this on the work item and is paused until someone
            replies there
            {replyTo ? (
              <>
                ; then it goes on to <Mono>{replyTo}</Mono>
              </>
            ) : null}
            . You can also answer here.
          </>
        ) : (
          "The run is paused until someone decides. Each choice sends it down a different branch."
        )}
        {open ? ` Waiting since ${formatDateTime(visit.createdAt)}.` : null}
      </Typography>
      {isReply ? (
        visit.questions.map((question) => (
          <Quote key={question.questionId} open={open}>
            <Typography
              sx={{
                fontSize: 16,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {bodies.get(question.commentId) ??
                "Question asked on the work item."}
            </Typography>
            <MuiLink
              component={Link}
              href={`${projectPath("work-items", workItemId)}#comment-${question.commentId}`}
              variant="caption"
              underline="hover"
            >
              View on the work item
            </MuiLink>
          </Quote>
        ))
      ) : (
        <Quote open={open}>
          <Typography sx={{ fontSize: 16 }}>
            {node.title ?? `Decide at ${visit.nodeId}`}
          </Typography>
          {Object.keys(visit.input).length > 0 ? (
            <Box sx={{ mt: 1 }} data-testid="decision-input">
              <JsonBlock value={visit.input} />
            </Box>
          ) : null}
        </Quote>
      )}
      {visit.error ? (
        <Typography variant="body2" color="error.main" sx={{ mb: 2 }}>
          {visit.error.name}: {visit.error.message}
        </Typography>
      ) : null}
      {open ? (
        ask ? (
          <Stack spacing={1}>
            {waitingOn ? (
              <Typography variant="body2" color="text.secondary">
                {waitingOn}
              </Typography>
            ) : null}
            <WaitAnswerBox ask={ask} pending={controls.pending} />
          </Stack>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {isReply
              ? "You don't have permission to answer here."
              : "You don't have permission to decide in this project."}
          </Typography>
        )
      ) : (
        <Stack spacing={1}>
          <Resolution visit={visit} />
          <Typography variant="body2" color="text.secondary">
            <TextLink onClick={onOpenDetails}>Show details</TextLink>
          </Typography>
        </Stack>
      )}
    </PaneFrame>
  );
}

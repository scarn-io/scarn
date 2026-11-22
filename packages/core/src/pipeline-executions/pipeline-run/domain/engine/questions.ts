/**
 * What visits post: the question comment a `reply` wait asks, the message an
 * agent hands over with, and marking open questions not needed when their
 * visit closes unanswered.
 */
import type { JsonValue } from "@scarn/sdk/contracts/pipeline-document";
import {
  agentMessageBody,
  MAX_AGENT_MESSAGE_LENGTH,
} from "@scarn/core/conversations/conversation/domain/agent-message-body";
import { emit, type EngineContext } from "./state";
import type { RoutingNote, Visit } from "./types";

export const MAX_QUESTIONS = 10;
export const MAX_QUESTION_LENGTH = 500;
export const DEFAULT_QUESTION =
  "What did you do, what did you expect, and what happened instead?";
export {
  MAX_AGENT_MESSAGE_LENGTH as MAX_AGENT_QUESTION_LENGTH,
  AGENT_MESSAGE_CUT_SUFFIX as AGENT_QUESTION_CUT_SUFFIX,
} from "@scarn/core/conversations/conversation/domain/agent-message-body";

export interface QuestionBody {
  body: string;
  notes: RoutingNote[];
}

/**
 * The fixed text a `reply` wait posts: at most `MAX_QUESTIONS` questions,
 * each trimmed and cut to `MAX_QUESTION_LENGTH`; the default question when
 * none are left.
 */
export function buildQuestionBody(
  questions: JsonValue | undefined,
): QuestionBody {
  const all = (Array.isArray(questions) ? questions : [])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().slice(0, MAX_QUESTION_LENGTH).trim())
    .filter((entry) => entry.length > 0);
  const asked =
    all.length === 0 ? [DEFAULT_QUESTION] : all.slice(0, MAX_QUESTIONS);
  const dropped = all.length - Math.min(all.length, MAX_QUESTIONS);
  return {
    body: [
      "Before I can go on, could you answer:",
      "",
      ...asked.map((question) => `- ${question}`),
    ].join("\n"),
    notes:
      dropped > 0
        ? [{ kind: "questions_dropped", asked: asked.length, dropped }]
        : [],
  };
}

/**
 * The message a step visit's agent hands over with (posted by the Task, see
 * `agentMessageBody`), with a `question_cut` note when it was cut.
 */
export function buildAgentMessageBody(message: string): QuestionBody {
  const { body, length } = agentMessageBody(message);
  return {
    body,
    notes:
      length > MAX_AGENT_MESSAGE_LENGTH
        ? [{ kind: "question_cut", length, limit: MAX_AGENT_MESSAGE_LENGTH }]
        : [],
  };
}

/** Marks the open questions of `visits` not needed. */
export function closeQuestions(
  ctx: EngineContext,
  visits: readonly Visit[],
): void {
  const ids = new Set(visits.map((visit) => visit.id));
  for (const question of ctx.questions) {
    if (question.status === "open" && ids.has(question.visitId)) {
      emit(ctx, {
        type: "updateQuestion",
        questionId: question.id,
        patch: { status: "not_needed", resolvedAt: ctx.options.now },
      });
    }
  }
}

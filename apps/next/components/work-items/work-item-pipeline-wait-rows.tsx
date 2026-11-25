"use client";

/** The agents panel's rows for a pipeline run paused on a question or a decision. */

import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import PanToolOutlinedIcon from "@mui/icons-material/PanToolOutlined";
import {
  parseUuidV7,
  type WorkItemQuestionContract,
} from "@scarn/api/frontend-contracts";
import type { DecisionActionContract } from "@scarn/core/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import {
  useHasProjectPermission,
  useIsProjectMember,
  useProjectPath,
} from "@/components/project-route-context";
import { formatRelativeTime } from "@/components/executions/format-datetime";
import type { DecisionWait } from "./use-work-item-decision-waits";
import {
  QuestionBlock,
  ReplyBox,
  RowHeader,
  useRowAction,
  waitingOnLabel,
} from "./work-item-agents-panel-parts";

export function PipelineQuestionRow({
  question,
  onChanged,
}: {
  question: WorkItemQuestionContract;
  onChanged: () => void;
}) {
  const projectPath = useProjectPath();
  const isMember = useIsProjectMember();
  const canComment = useHasProjectPermission("comments:write") && isMember;
  const canAct = useHasProjectPermission("executions:write") && isMember;
  const { pending, error, run } = useRowAction(onChanged);
  const questionRoute = () =>
    getBrowserScarnApiClient()
      .api["pipeline-executions"]({
        pipelineExecutionId: parseUuidV7(question.pipelineExecutionId),
      })
      .questions({ questionId: parseUuidV7(question.questionId) });

  return (
    <Stack spacing={1.25} sx={{ px: 2, py: 1.5 }} data-testid="question-row">
      <RowHeader
        icon={<ForumOutlinedIcon fontSize="small" color="warning" />}
        name="Pipeline question"
        href={projectPath("runs", question.pipelineExecutionId)}
        status={
          <Chip
            size="small"
            variant="outlined"
            color="warning"
            label="Waiting for reply"
          />
        }
        waitingOnYou={question.waitingOnYou}
        waitingOn={question.waitingOn}
      />
      {error ? <Alert severity="error">{error}</Alert> : null}
      <QuestionBlock
        body={question.body}
        caption={`Asked ${formatRelativeTime(question.askedAt)}`}
        highlighted={question.waitingOnYou}
      />
      {canComment || canAct ? (
        <ReplyBox
          placeholder="Answer the question…"
          note={
            !question.waitingOnYou && question.waitingOn.length > 0
              ? `Waiting on ${waitingOnLabel(question.waitingOn)} — you can still reply`
              : null
          }
          pending={pending !== null}
          canReply={canComment}
          onReply={(body) =>
            run("answer", "Could not send the answer. Try again.", () =>
              unwrapTreatyResponse(questionRoute().answer.post({ body })),
            )
          }
        >
          {canAct ? (
            <Button
              size="small"
              variant="outlined"
              disabled={pending !== null}
              onClick={() => {
                void run(
                  "continue",
                  "Could not continue without a reply.",
                  () => unwrapTreatyResponse(questionRoute().continue.post()),
                );
              }}
            >
              Continue without reply
            </Button>
          ) : null}
        </ReplyBox>
      ) : null}
    </Stack>
  );
}

export function DecisionRow({
  wait,
  onChanged,
}: {
  wait: DecisionWait;
  onChanged: () => void;
}) {
  const projectPath = useProjectPath();
  const isMember = useIsProjectMember();
  const canAct = useHasProjectPermission("executions:write") && isMember;
  const { pending, error, run } = useRowAction(onChanged);

  return (
    <Stack spacing={1.25} sx={{ px: 2, py: 1.5 }} data-testid="decision-row">
      <RowHeader
        icon={<PanToolOutlinedIcon fontSize="small" color="warning" />}
        name="Pipeline decision"
        href={projectPath("runs", wait.execution.id)}
        status={
          <Chip
            size="small"
            variant="outlined"
            color="warning"
            label="Waiting for a decision"
          />
        }
        waitingOnYou={false}
        waitingOn={[]}
      />
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Typography variant="body2" color="text.secondary">
        The run is paused at{" "}
        <Box component="span" sx={{ fontFamily: "var(--font-mono)" }}>
          {wait.visit.nodeId}
        </Box>{" "}
        until someone decides.
      </Typography>
      {canAct ? (
        <DecisionControls
          actions={wait.visit.actions ?? []}
          pending={pending !== null}
          onDecide={(action, body) =>
            run(action, "Could not record the decision.", () =>
              postDecision(wait.execution.id, wait.visit.id, action, body),
            )
          }
        />
      ) : null}
    </Stack>
  );
}

export const postDecision = (
  pipelineExecutionId: string,
  visitId: string,
  action: string,
  body: string,
) =>
  unwrapTreatyResponse(
    getBrowserScarnApiClient()
      .api["pipeline-executions"]({
        pipelineExecutionId: parseUuidV7(pipelineExecutionId),
      })
      .visits({ visitId: parseUuidV7(visitId) })
      .decision.post(body ? { action, body } : { action }),
  );

/** A decision wait's optional note box and one button per action. */
export function DecisionControls({
  actions,
  pending,
  onDecide,
}: {
  actions: readonly DecisionActionContract[];
  pending: boolean;
  onDecide: (action: string, body: string) => Promise<boolean>;
}) {
  const [note, setNote] = useState("");
  const trimmed = note.trim();
  return (
    <>
      {actions.length > 0 ? (
        <TextField
          fullWidth
          multiline
          minRows={2}
          size="small"
          placeholder="Note (optional)"
          value={note}
          disabled={pending}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          slotProps={{ htmlInput: { "aria-label": "Decision note" } }}
        />
      ) : null}
      <Stack
        direction="row"
        spacing={1}
        justifyContent="flex-end"
        useFlexGap
        flexWrap="wrap"
      >
        {actions.map((action, index) => (
          <Button
            key={action.key}
            size="small"
            variant={index === actions.length - 1 ? "contained" : "outlined"}
            disabled={pending || (action.body === "required" && trimmed === "")}
            onClick={() => {
              void onDecide(action.key, trimmed).then((ok) => {
                if (ok) setNote("");
              });
            }}
          >
            {action.label}
          </Button>
        ))}
      </Stack>
    </>
  );
}

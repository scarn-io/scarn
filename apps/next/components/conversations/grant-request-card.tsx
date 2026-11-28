"use client";

/**
 * The card on an agent message asking for more access: the agent's reason,
 * one checkbox per requested grant written as its sentence, labels as
 * removable chips, an optional note, and **Approve selected** / **Deny**.
 * Once closed it shows the outcome, who decided and when.
 */

import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { Grant } from "@scarn/core/tasks/task/domain/grants";
import { grantSentence } from "@scarn/sdk/definitions/steps/work-item-features";
import { formatDateTime } from "@/components/executions/format-datetime";
import { useHasProjectPermission } from "@/components/project-route-context";
import {
  decideGrantRequest,
  useGrantRequest,
  type GrantRequest,
  type GrantRequestDecisionOutcome,
} from "./grant-request-api";

const NOTE_MAX_LENGTH = 2000;

/** A grant sentence with its `code` spans set in monospace. */
export function GrantSentence({ grant }: { grant: Grant }) {
  const parts = grantSentence(grant).split("`");
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <Box
            key={index}
            component="code"
            sx={{ fontFamily: "var(--font-mono)", fontSize: "0.9em" }}
          >
            {part}
          </Box>
        ) : (
          part
        ),
      )}
    </>
  );
}

type Choice = { checked: boolean; labels: string[] | undefined };

const grantLabels = (grant: Grant): string[] | undefined =>
  "labels" in grant && grant.labels !== undefined
    ? [...grant.labels]
    : undefined;

const withLabels = (grant: Grant, labels: string[] | undefined): Grant =>
  labels === undefined ? grant : ({ ...grant, labels } as Grant);

/** Why the viewer can't approve `selected`; null when they can. */
export function approveBlockedReason(
  selected: readonly Grant[],
  permissions: { executions: boolean; workItems: boolean },
): string | null {
  if (!permissions.executions) {
    return "Only people who can run steps can decide on access.";
  }
  if (selected.length === 0) {
    return "Select at least one grant to approve, or deny the request.";
  }
  if (!permissions.workItems && selected.some((g) => g.action !== "read")) {
    return "Approving a grant that changes work items needs permission to edit work items.";
  }
  return null;
}

function outcomeText(request: GrantRequest): string {
  switch (request.status) {
    case "pending":
      return "Waiting for a decision.";
    case "unanswered":
      return "Left unanswered: someone replied or continued instead, so nothing was granted.";
    case "withdrawn":
      return "Withdrawn: the Task stopped waiting before anyone decided.";
    case "decided": {
      const approved = request.approved ?? [];
      const requested = request.requested.length;
      if (approved.length === 0) return "Denied.";
      if (approved.length === requested) {
        return requested === 1
          ? "Approved."
          : `Approved all ${String(requested)} grants.`;
      }
      return `Approved ${String(approved.length)} of ${String(requested)} grants.`;
    }
  }
}

export function GrantRequestCard({
  request,
  decidedBy,
  canWriteExecutions,
  canWriteWorkItems,
  onDecide,
}: {
  request: GrantRequest;
  /** Who decided, as the conversation names them; null when unknown. */
  decidedBy: string | null;
  canWriteExecutions: boolean;
  canWriteWorkItems: boolean;
  onDecide: (
    approved: Grant[],
    note: string,
  ) => Promise<GrantRequestDecisionOutcome>;
}) {
  const [choices, setChoices] = useState<Choice[]>(() =>
    request.requested.map((grant) => ({
      checked: true,
      labels: grantLabels(grant),
    })),
  );
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const isPending = request.status === "pending";

  const selected = request.requested.flatMap((grant, index) => {
    const choice = choices[index];
    return choice?.checked ? [withLabels(grant, choice.labels)] : [];
  });
  const blocked = approveBlockedReason(selected, {
    executions: canWriteExecutions,
    workItems: canWriteWorkItems,
  });

  const update = (index: number, change: Partial<Choice>) => {
    setChoices((prev) =>
      prev.map((choice, i) =>
        i === index ? { ...choice, ...change } : choice,
      ),
    );
  };

  const decide = async (approved: Grant[]) => {
    setPending(true);
    setError("");
    const outcome = await onDecide(approved, note);
    setPending(false);
    if (!outcome.ok) setError(outcome.error);
  };

  const grants = isPending ? request.requested : (request.approved ?? []);

  return (
    <Box
      data-testid="grant-request-card"
      data-status={request.status}
      sx={{
        p: 1.75,
        borderRadius: 2,
        border: 1,
        borderColor: (theme) =>
          isPending
            ? alpha(theme.palette.warning.main, 0.5)
            : theme.palette.divider,
        backgroundColor: (theme) => alpha(theme.palette.text.primary, 0.03),
      }}
    >
      <Stack spacing={1.25}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          The agent is asking for more access
        </Typography>
        <Typography
          component="blockquote"
          variant="body2"
          sx={{
            m: 0,
            pl: 1.25,
            borderLeft: 2,
            borderColor: "divider",
            color: "text.secondary",
            whiteSpace: "pre-wrap",
          }}
        >
          {request.reason}
        </Typography>
        {isPending ? (
          <Stack spacing={0.5}>
            {request.requested.map((grant, index) => {
              const choice = choices[index] ?? { checked: false, labels: [] };
              return (
                <Box key={index}>
                  <FormControlLabel
                    disabled={pending}
                    control={
                      <Checkbox
                        size="small"
                        checked={choice.checked}
                        onChange={(event) => {
                          update(index, { checked: event.target.checked });
                        }}
                      />
                    }
                    label={
                      <Typography variant="body2">
                        <GrantSentence
                          grant={withLabels(grant, choice.labels)}
                        />
                      </Typography>
                    }
                    sx={{
                      alignItems: "flex-start",
                      "& .MuiCheckbox-root": { pt: 0.25 },
                    }}
                  />
                  {choice.labels ? (
                    <Stack
                      direction="row"
                      spacing={0.5}
                      useFlexGap
                      flexWrap="wrap"
                      sx={{ pl: 4 }}
                    >
                      {choice.labels.map((label) => (
                        <Chip
                          key={label}
                          size="small"
                          label={label}
                          disabled={pending || !choice.checked}
                          {...((choice.labels?.length ?? 0) > 1
                            ? {
                                onDelete: () => {
                                  update(index, {
                                    labels: choice.labels?.filter(
                                      (l) => l !== label,
                                    ),
                                  });
                                },
                              }
                            : {})}
                        />
                      ))}
                    </Stack>
                  ) : null}
                </Box>
              );
            })}
          </Stack>
        ) : (
          <Stack spacing={0.5}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {outcomeText(request)}
            </Typography>
            {grants.map((grant, index) => (
              <Typography key={index} variant="body2" color="text.secondary">
                <GrantSentence grant={grant} />
              </Typography>
            ))}
            {request.note ? (
              <Typography variant="body2" color="text.secondary">
                Note: {request.note}
              </Typography>
            ) : null}
            {request.status === "decided" ? (
              <Typography variant="caption" color="text.disabled">
                {[
                  decidedBy ? `By ${decidedBy}` : null,
                  formatDateTime(request.decidedAt),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Typography>
            ) : null}
          </Stack>
        )}
        {isPending ? (
          <>
            <TextField
              size="small"
              multiline
              label="Note for the agent (optional)"
              value={note}
              disabled={pending || !canWriteExecutions}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              slotProps={{ htmlInput: { maxLength: NOTE_MAX_LENGTH } }}
            />
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="contained"
                disabled={pending || blocked !== null}
                onClick={() => {
                  void decide(selected);
                }}
              >
                Approve selected
              </Button>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                disabled={pending || !canWriteExecutions}
                onClick={() => {
                  void decide([]);
                }}
              >
                Deny
              </Button>
            </Stack>
            {blocked ? (
              <Typography variant="caption" color="text.secondary">
                {blocked}
              </Typography>
            ) : null}
            {error ? <Alert severity="error">{error}</Alert> : null}
          </>
        ) : null}
      </Stack>
    </Box>
  );
}

/** Loads the request an agent message carries and shows its card. */
export function GrantRequestMessageCard({
  grantRequestId,
  taskRunId,
  refreshKey,
  decidedBy,
  onDecided,
}: {
  grantRequestId: string;
  taskRunId: string | null;
  /** Changes when the conversation does, so the request is read again. */
  refreshKey: string;
  decidedBy: string | null;
  onDecided: () => void;
}) {
  const canWriteExecutions = useHasProjectPermission("executions:write");
  const canWriteWorkItems = useHasProjectPermission("work-items:write");
  const state = useGrantRequest(grantRequestId, taskRunId, refreshKey);
  if (state.status === "loading") {
    return (
      <Typography variant="body2" color="text.secondary">
        Loading the access request…
      </Typography>
    );
  }
  if (state.status === "error") {
    return <Alert severity="warning">{state.message}</Alert>;
  }
  return (
    <GrantRequestCard
      key={`${state.request.id}:${state.request.status}`}
      request={state.request}
      decidedBy={decidedBy}
      canWriteExecutions={canWriteExecutions}
      canWriteWorkItems={canWriteWorkItems}
      onDecide={async (approved, note) => {
        const outcome = await decideGrantRequest(
          state.request.id,
          approved,
          note,
        );
        if (outcome.ok) onDecided();
        return outcome;
      }}
    />
  );
}

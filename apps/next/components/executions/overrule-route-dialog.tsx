"use client";

/**
 * The Overrule dialog: a person picks the routes a succeeded step visit
 * should have taken (a radio list under `match: "first"`, a checklist under
 * `match: "all"` with `otherwise` following the other boxes), gives a reason,
 * and sees a preview of what the overrule would do before confirming.
 */

import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import type {
  NodeVisitContract,
  PipelineVersionContract,
} from "@scarn/api/frontend-contracts";
import {
  allModeRouteSet,
  describePreview,
  nodeNext,
  nodeTitle,
  readVisitRouting,
  routeChoices,
  sameRoute,
  sameRouteSet,
  type RouteChoice,
  type RouteRef,
} from "./overrule-routes";
import {
  ROUTE_ARGS_MISSING,
  useApplyOverrule,
  useCodeStepTargets,
  useOverrulePreview,
  type MissingArg,
  type OverruleRefusal,
  type PostVisitRoute,
  type PreviewState,
} from "./use-overrule-route";

const NOT_OVERRIDABLE = "Not marked overridable by the pipeline author";

function choiceNote(choice: RouteChoice, allMode: boolean): string | null {
  if (allMode && choice.kind === "otherwise") {
    return "Follows the other routes: taken when no route with a condition is";
  }
  if (choice.unconditional) return "Always taken: it has no condition";
  return choice.overridable ? null : NOT_OVERRIDABLE;
}

function ChoiceLabel({
  choice,
  note,
}: {
  choice: RouteChoice;
  note: string | null;
}) {
  return (
    <Box sx={{ py: 0.25 }}>
      <Typography variant="body2">{choice.label}</Typography>
      {note ? (
        <Typography variant="caption" color="text.secondary">
          {note}
        </Typography>
      ) : null}
    </Box>
  );
}

function MissingArgsList({ missing }: { missing: readonly MissingArg[] }) {
  return (
    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
      {missing.map((entry) => (
        <li key={`${entry.arg}:${entry.reference}`}>
          <Typography variant="body2">
            <code>{entry.arg}</code> ({entry.reference})
          </Typography>
        </li>
      ))}
    </Box>
  );
}

function PreviewPanel({
  state,
  titleOf,
  refusal,
  codeStep,
  acceptMissing,
  onAcceptMissingChange,
}: {
  state: PreviewState;
  titleOf: (nodeId: string) => string;
  refusal: OverruleRefusal | null;
  codeStep: boolean;
  acceptMissing: boolean;
  onAcceptMissingChange: (accept: boolean) => void;
}) {
  const shownRefusal =
    refusal ?? (state.kind === "refused" ? state.refusal : null);
  const missing =
    shownRefusal?.code === ROUTE_ARGS_MISSING
      ? shownRefusal.missing
      : state.kind === "ready"
        ? state.preview.missing
        : [];
  const missingControls =
    missing.length > 0 ? (
      <Stack spacing={1}>
        <Typography variant="body2">
          These args resolve to nothing on the new route:
        </Typography>
        <MissingArgsList missing={missing} />
        {codeStep ? (
          <Typography variant="body2" color="text.secondary">
            The route leads to a code or MCP tool step, which can&apos;t run
            with missing args, so you can&apos;t continue without them.
          </Typography>
        ) : (
          <FormControlLabel
            control={
              <Checkbox
                checked={acceptMissing}
                onChange={(event) => {
                  onAcceptMissingChange(event.target.checked);
                }}
              />
            }
            label="Continue without them"
          />
        )}
      </Stack>
    ) : null;

  if (state.kind === "idle") return null;
  if (state.kind === "loading") {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={14} />
        <Typography variant="body2" color="text.secondary">
          Checking what this would do…
        </Typography>
      </Stack>
    );
  }
  if (shownRefusal) {
    return (
      <Stack spacing={1.5}>
        <Alert severity="error">{shownRefusal.message}</Alert>
        {missingControls}
      </Stack>
    );
  }
  if (state.kind !== "ready") return null;
  return (
    <Stack spacing={1.5}>
      <Alert severity="info" icon={false} data-testid="overrule-preview">
        {describePreview(state.preview, titleOf)}
      </Alert>
      {missingControls}
    </Stack>
  );
}

export function OverruleRouteDialog({
  visit,
  version,
  postVisitRoute,
  onClose,
  onApplied,
}: {
  visit: NodeVisitContract;
  version: PipelineVersionContract | null;
  postVisitRoute: PostVisitRoute;
  onClose: () => void;
  /** Runs once the overrule went through, e.g. to reload the run. */
  onApplied: () => void;
}) {
  const next = nodeNext(version, visit.nodeId);
  const allMode = next?.match === "all";
  const choices = useMemo(() => routeChoices(version, next), [version, next]);
  const taken = useMemo(
    () => readVisitRouting(visit.routing)?.taken ?? [],
    [visit.routing],
  );
  const titleOf = (nodeId: string) => nodeTitle(version, nodeId);

  const [selected, setSelected] = useState<string | null>(
    () =>
      choices.find((choice) => taken.some((route) => sameRoute(choice, route)))
        ?.key ?? null,
  );
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        choices
          .filter((choice) => taken.some((route) => sameRoute(choice, route)))
          .map((choice) => choice.key),
      ),
  );
  const [reason, setReason] = useState("");
  const [acceptMissing, setAcceptMissing] = useState(false);

  const chosen: RouteRef[] = useMemo(() => {
    if (allMode) return allModeRouteSet(choices, ticked);
    const choice = choices.find((candidate) => candidate.key === selected);
    return choice ? [{ kind: choice.kind, index: choice.index }] : [];
  }, [allMode, choices, ticked, selected]);
  const changed = chosen.length > 0 && !sameRouteSet(chosen, taken);

  const turnedOnTargets = choices
    .filter(
      (choice) =>
        chosen.some((route) => sameRoute(choice, route)) &&
        !taken.some((route) => sameRoute(choice, route)),
    )
    .map((choice) => choice.to);
  const codeSteps = useCodeStepTargets(version, turnedOnTargets);
  const codeStep = turnedOnTargets.some((nodeId) => codeSteps?.has(nodeId));

  const preview = useOverrulePreview(
    postVisitRoute,
    visit.id,
    changed ? chosen : null,
    acceptMissing,
  );
  const { apply, pending, refusal } = useApplyOverrule(
    postVisitRoute,
    visit.id,
    onApplied,
  );

  const canConfirm =
    changed && preview.kind === "ready" && reason.trim() !== "" && !pending;
  const choose = (update: () => void) => {
    setAcceptMissing(false);
    update();
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Overrule the route of {titleOf(visit.nodeId)}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            {allMode
              ? "Pick every route this step should take. The result stays as it was."
              : "Pick the route this step should take. The result stays as it was."}
          </Typography>
          {allMode ? (
            <Stack role="group" aria-label="Routes">
              {choices.map((choice) => {
                const on = chosen.some((route) => sameRoute(choice, route));
                const fixed =
                  choice.kind === "otherwise" ||
                  choice.unconditional ||
                  !choice.overridable;
                return (
                  <FormControlLabel
                    key={choice.key}
                    control={
                      <Checkbox
                        checked={on}
                        disabled={fixed}
                        onChange={(event) => {
                          const { checked } = event.target;
                          choose(() => {
                            setTicked((current) => {
                              const updated = new Set(current);
                              if (checked) updated.add(choice.key);
                              else updated.delete(choice.key);
                              return updated;
                            });
                          });
                        }}
                      />
                    }
                    label={
                      <ChoiceLabel
                        choice={choice}
                        note={choiceNote(choice, true)}
                      />
                    }
                  />
                );
              })}
            </Stack>
          ) : (
            <RadioGroup
              aria-label="Route"
              value={selected ?? ""}
              onChange={(event) => {
                const { value } = event.target;
                choose(() => {
                  setSelected(value);
                });
              }}
            >
              {choices.map((choice) => (
                <FormControlLabel
                  key={choice.key}
                  value={choice.key}
                  disabled={!choice.overridable}
                  control={<Radio />}
                  label={
                    <ChoiceLabel
                      choice={choice}
                      note={choiceNote(choice, false)}
                    />
                  }
                />
              ))}
            </RadioGroup>
          )}
          <TextField
            label="Reason"
            required
            multiline
            minRows={2}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            helperText="Recorded with the overrule"
            slotProps={{ htmlInput: { maxLength: 2000 } }}
          />
          <PreviewPanel
            state={preview}
            titleOf={titleOf}
            refusal={refusal}
            codeStep={codeStep}
            acceptMissing={acceptMissing}
            onAcceptMissingChange={setAcceptMissing}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!canConfirm}
          onClick={() => {
            apply(chosen, reason, acceptMissing);
          }}
        >
          {pending ? "Overruling…" : "Overrule"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

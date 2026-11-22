"use client";

import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CheckIcon from "@mui/icons-material/Check";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Box,
  Button,
  Divider,
  FormControl,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Popover,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type MouseEvent, type ReactNode } from "react";
import type { UuidV7 } from "@scarn/api/frontend-contracts";
import { useMenu } from "@/components/common/use-menu";
import type { ScoreSortPipeline } from "@/components/work-items/filters/score-sort-catalog";
import {
  formatWorkItemSort,
  type WorkItemSort,
} from "@/components/work-items/project-work-items-params";

const NONE = "";
const PANE_WIDTH = 280;

type WorkItemSortAxis = WorkItemSort["kind"];
type SortDirection = "asc" | "desc";

type ScoreDraft = {
  pipelineId: UuidV7 | undefined;
  stepKey: string | undefined;
  signalKey: string | undefined;
};

const EMPTY_SCORE_DRAFT: ScoreDraft = {
  pipelineId: undefined,
  stepKey: undefined,
  signalKey: undefined,
};

/**
 * Labels for the shared direction section's two rows, keyed by axis — the
 * same two controls answer every axis, only their words change (decision 6,
 * `docs/plans/work-item-sort.md`).
 */
const DIRECTION_LABELS: Record<WorkItemSortAxis, [desc: string, asc: string]> =
  {
    created: ["Newest first", "Oldest first"],
    updated: ["Most recently updated", "Least recently updated"],
    score: ["Highest first", "Lowest first"],
  };

const buttonLabel = (
  sort: WorkItemSort,
  scoreLabel: string | undefined,
): string => {
  if (sort.kind === "created") {
    return sort.direction === "desc" ? "Newest" : "Oldest";
  }
  if (sort.kind === "updated") {
    return sort.direction === "desc"
      ? "Recently updated"
      : "Least recently updated";
  }
  return scoreLabel ?? "Sort";
};

const isScoreDraftComplete = (
  draft: ScoreDraft,
): draft is { pipelineId: UuidV7; stepKey: string; signalKey: string } =>
  Boolean(draft.pipelineId && draft.stepKey && draft.signalKey);

/**
 * The sort control: an axis section (Created / Updated / Score) on top, and a
 * shared direction section on the bottom whose two rows' labels are keyed off
 * the resolved axis (decisions 1 and 6, `docs/plans/work-item-sort.md`).
 * Choosing Score expands its row in place into the Pipeline → Step → Field
 * cascade — this product's own differentiator, with no GitHub equivalent. The
 * fields are the number fields of each step's result schema
 * (`score:<pipeline>:<step>:<result path>`).
 *
 * Sort deliberately gets no chip. An active sort already reports itself in the
 * results — the score column only appears when one is set — so a chip would say
 * the same thing twice, in the one place reserved for clauses that actually
 * narrow the list.
 *
 * The menu never auto-closes on a pick: axis, cascade, and direction rows all
 * write straight through the URL as a whole value, not a diff, so a person can
 * chain several related choices — pick Score, walk the cascade, flip the
 * direction — without reopening the popover each time.
 */
export function SortMenu({
  scoreCatalog,
  sort,
  scoreLabel,
}: {
  scoreCatalog: ScoreSortPipeline[];
  sort: WorkItemSort;
  scoreLabel: string | undefined;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const menu = useMenu();

  const [axis, setAxis] = useState<WorkItemSortAxis>(sort.kind);
  const [direction, setDirection] = useState<SortDirection>(sort.direction);
  const [scoreDraft, setScoreDraft] = useState<ScoreDraft>(
    sort.kind === "score"
      ? {
          pipelineId: sort.pipelineDefinitionId,
          stepKey: sort.stepKey,
          signalKey: sort.signalKey,
        }
      : EMPTY_SCORE_DRAFT,
  );

  const selectedDefinition = scoreCatalog.find(
    (d) => d.id === scoreDraft.pipelineId,
  );
  const selectedStep = selectedDefinition?.steps.find(
    (s) => s.stepKey === scoreDraft.stepKey,
  );
  const resultPaths = selectedStep?.resultPaths ?? [];

  // The direction section only lights up once the axis is actually
  // resolvable — immediately for created/updated, and only once the full
  // pipeline/step/field triple is chosen for score.
  const axisResolved =
    axis === "created" || axis === "updated"
      ? true
      : isScoreDraftComplete(scoreDraft);

  // Re-derives the popover's working state from the committed `sort` every
  // time it's reopened, so a stale in-progress cascade never survives a close.
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    setAxis(sort.kind);
    setDirection(sort.direction);
    setScoreDraft(
      sort.kind === "score"
        ? {
            pipelineId: sort.pipelineDefinitionId,
            stepKey: sort.stepKey,
            signalKey: sort.signalKey,
          }
        : EMPTY_SCORE_DRAFT,
    );
    menu.onOpen(event);
  };

  // Written as a whole value rather than a diff: this is the one write path
  // for the entire control, whichever axis or row triggered it.
  const commitSort = (next: WorkItemSort | undefined) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    if (next) {
      params.set("sort", formatWorkItemSort(next));
    } else {
      params.delete("sort");
    }
    const query = params.toString();
    router.push(query.length > 0 ? `${pathname}?${query}` : pathname);
  };

  // A partial score draft has no valid token to write — the schema requires
  // the whole pipeline/step/field triple — so an incomplete draft clears the
  // sort rather than committing something invalid.
  const commitScoreDraft = (
    draft: ScoreDraft,
    nextDirection: SortDirection,
  ) => {
    if (isScoreDraftComplete(draft)) {
      commitSort({
        kind: "score",
        pipelineDefinitionId: draft.pipelineId,
        stepKey: draft.stepKey,
        signalKey: draft.signalKey,
        direction: nextDirection,
      });
    } else {
      commitSort(undefined);
    }
  };

  const chooseAxis = (nextAxis: WorkItemSortAxis) => {
    setAxis(nextAxis);
    if (nextAxis === "score") {
      commitScoreDraft(scoreDraft, direction);
      return;
    }
    commitSort({ kind: nextAxis, direction });
  };

  const chooseDirection = (nextDirection: SortDirection) => {
    setDirection(nextDirection);
    if (axis === "created" || axis === "updated") {
      commitSort({ kind: axis, direction: nextDirection });
      return;
    }
    commitScoreDraft(scoreDraft, nextDirection);
  };

  // A single candidate is not a choice; skipping the extra click is the
  // difference between one interaction and three for most projects.
  const handlePipelineChange = (pipelineId: string) => {
    const definition = scoreCatalog.find((d) => d.id === pipelineId);
    if (!definition) {
      setScoreDraft(EMPTY_SCORE_DRAFT);
      commitScoreDraft(EMPTY_SCORE_DRAFT, direction);
      return;
    }

    const { steps } = definition;
    const autoStep = steps.length === 1 ? steps[0] : undefined;
    const autoPaths = autoStep?.resultPaths ?? [];

    const draft: ScoreDraft = {
      pipelineId: definition.id,
      stepKey: autoStep?.stepKey,
      signalKey: autoPaths.length === 1 ? autoPaths[0] : undefined,
    };
    setScoreDraft(draft);
    commitScoreDraft(draft, direction);
  };

  const handleStepChange = (stepKey: string) => {
    const step = selectedDefinition?.steps.find((s) => s.stepKey === stepKey);
    const paths = step?.resultPaths ?? [];

    const draft: ScoreDraft = {
      pipelineId: scoreDraft.pipelineId,
      stepKey: step?.stepKey,
      signalKey: paths.length === 1 ? paths[0] : undefined,
    };
    setScoreDraft(draft);
    commitScoreDraft(draft, direction);
  };

  const handleFieldChange = (signalKey: string) => {
    const draft: ScoreDraft = {
      pipelineId: scoreDraft.pipelineId,
      stepKey: scoreDraft.stepKey,
      signalKey: signalKey.length > 0 ? signalKey : undefined,
    };
    setScoreDraft(draft);
    commitScoreDraft(draft, direction);
  };

  const axisItem = (candidate: WorkItemSortAxis, label: string) => (
    <ListItemButton
      key={candidate}
      selected={axis === candidate}
      onClick={() => {
        chooseAxis(candidate);
      }}
    >
      <ListItemText primary={label} />
      {axis === candidate ? (
        <CheckIcon fontSize="small" color="primary" />
      ) : (
        candidate === "score" && (
          <ChevronRightIcon fontSize="small" color="action" />
        )
      )}
    </ListItemButton>
  );

  const directionItem = (
    value: SortDirection,
    label: string,
    icon: ReactNode,
  ) => (
    <ListItemButton
      key={value}
      selected={direction === value}
      onClick={() => {
        chooseDirection(value);
      }}
    >
      <Box
        sx={{
          display: "flex",
          width: 18,
          mr: 1,
          color: "text.secondary",
        }}
      >
        {icon}
      </Box>
      <ListItemText primary={label} />
      {direction === value && <CheckIcon fontSize="small" color="primary" />}
    </ListItemButton>
  );

  // "Sort by" / "Order" — the two questions this control answers, named so
  // a person can tell at a glance which section resolves the axis and which
  // resolves its direction (mirrors GitHub's sort menu structure).
  const sectionLabel = (label: string) => (
    <Typography variant="subtitle2" sx={{ px: 2, pt: 1.5, pb: 0.5 }}>
      {label}
    </Typography>
  );

  const startIcon =
    sort.direction === "asc" ? (
      <ArrowUpwardIcon fontSize="small" />
    ) : (
      <ArrowDownwardIcon fontSize="small" />
    );

  return (
    <>
      <Button
        size="small"
        color="inherit"
        startIcon={startIcon}
        endIcon={<ExpandMoreIcon />}
        onClick={openMenu}
        sx={{ flexShrink: 0, whiteSpace: "nowrap", maxWidth: 260 }}
      >
        {buttonLabel(sort, scoreLabel)}
      </Button>
      <Popover
        open={menu.open}
        anchorEl={menu.anchorEl}
        onClose={menu.onClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <Box sx={{ width: PANE_WIDTH }}>
          {sectionLabel("Sort by")}
          <List dense sx={{ py: 0 }}>
            {axisItem("created", "Created")}
            {axisItem("updated", "Updated")}
            {scoreCatalog.length > 0 && axisItem("score", "Score")}
          </List>

          {axis === "score" && (
            <Box sx={{ px: 2, pb: 2, pt: 1 }}>
              <Stack spacing={1.5}>
                <FormControl size="small" fullWidth>
                  <InputLabel id="sort-pipeline-label">Pipeline</InputLabel>
                  <Select
                    labelId="sort-pipeline-label"
                    label="Pipeline"
                    value={selectedDefinition?.id ?? NONE}
                    onChange={(event) => {
                      handlePipelineChange(event.target.value);
                    }}
                  >
                    <MenuItem value={NONE}>
                      <em>None</em>
                    </MenuItem>
                    {scoreCatalog.map((d) => (
                      <MenuItem key={d.id} value={d.id}>
                        {d.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                {selectedDefinition && (
                  <FormControl size="small" fullWidth>
                    <InputLabel id="sort-step-label">Step</InputLabel>
                    <Select
                      labelId="sort-step-label"
                      label="Step"
                      value={selectedStep?.stepKey ?? NONE}
                      onChange={(event) => {
                        handleStepChange(event.target.value);
                      }}
                    >
                      <MenuItem value={NONE}>
                        <em>None</em>
                      </MenuItem>
                      {selectedDefinition.steps.map((s) => (
                        <MenuItem key={s.stepKey} value={s.stepKey}>
                          {s.name}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}

                {selectedStep && resultPaths.length > 1 && (
                  <FormControl size="small" fullWidth>
                    <InputLabel id="sort-field-label">Field</InputLabel>
                    <Select
                      labelId="sort-field-label"
                      label="Field"
                      value={scoreDraft.signalKey ?? NONE}
                      onChange={(event) => {
                        handleFieldChange(event.target.value);
                      }}
                    >
                      <MenuItem value={NONE}>
                        <em>None</em>
                      </MenuItem>
                      {resultPaths.map((path) => (
                        <MenuItem
                          key={path}
                          value={path}
                          sx={{ fontFamily: "var(--font-mono)" }}
                        >
                          {path}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}
              </Stack>
            </Box>
          )}

          {axisResolved && (
            <>
              <Divider />
              {sectionLabel("Order")}
              <List dense sx={{ py: 0 }}>
                {directionItem(
                  "desc",
                  DIRECTION_LABELS[axis][0],
                  <ArrowDownwardIcon fontSize="small" />,
                )}
                {directionItem(
                  "asc",
                  DIRECTION_LABELS[axis][1],
                  <ArrowUpwardIcon fontSize="small" />,
                )}
              </List>
            </>
          )}
        </Box>
      </Popover>
    </>
  );
}

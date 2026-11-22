"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Autocomplete,
  Box,
  Chip,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import CancelIcon from "@mui/icons-material/Cancel";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { fetchWorkItemLabels } from "@/app/(protected)/projects/_lib/project-work-items";
import {
  useHasProjectPermission,
  useIsProjectMember,
} from "@/components/project-route-context";

const LABEL_CHIP_SX = { height: 22, color: "text.secondary" };

function LabelChips({
  labels,
  onRemove,
  disabled,
}: {
  labels: readonly string[];
  onRemove?: (label: string) => void;
  disabled?: boolean;
}) {
  return (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
      {labels.map((label) => (
        <Chip
          key={label}
          label={label}
          size="small"
          variant="outlined"
          disabled={disabled}
          onDelete={
            onRemove
              ? () => {
                  onRemove(label);
                }
              : undefined
          }
          deleteIcon={<CancelIcon aria-label={`Remove label ${label}`} />}
          sx={LABEL_CHIP_SX}
        />
      ))}
    </Stack>
  );
}

/**
 * The Properties panel's Labels value. Scarn-created items take edits from a
 * viewer who may update work items, with the project's existing labels as
 * suggestions. Synced items show the tracker's labels read-only: the next
 * sync would overwrite any change made here.
 */
export function WorkItemLabels({
  projectId,
  workItem,
  onWorkItemChanged,
}: {
  projectId: string;
  workItem: WorkItemContract;
  onWorkItemChanged: (updated: WorkItemContract) => void;
}) {
  const isMember = useIsProjectMember();
  const canUpdate = useHasProjectPermission("work-items:update") && isMember;
  const editable = canUpdate && workItem.platform === "scarn";
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startAction] = useTransition();

  useEffect(() => {
    if (!editable) return;
    let cancelled = false;
    fetchWorkItemLabels(projectId)
      .then((labels) => {
        if (!cancelled) setSuggestions(labels);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [editable, projectId]);

  const labels = workItem.labels;

  if (!editable) {
    return labels.length === 0 ? (
      <Typography variant="body2" color="text.secondary">
        None
      </Typography>
    ) : (
      <LabelChips labels={labels} />
    );
  }

  const change = (body: { add?: string[]; remove?: string[] }) => {
    setActionError(null);
    startAction(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error } = await client.api["work-items"]({
        workItemId: parseWorkItemId(workItem.id),
      }).labels.patch(body);
      if (error) {
        setActionError(
          parseApiError(error, "Could not change labels. Try again."),
        );
        return;
      }
      onWorkItemChanged(data);
    });
  };

  const add = (raw: string) => {
    const label = raw.trim();
    setDraft("");
    if (label.length === 0 || labels.includes(label)) return;
    change({ add: [label] });
  };

  const remove = (label: string) => {
    change({ remove: [label] });
  };

  return (
    <Stack spacing={0.75}>
      {labels.length > 0 && (
        <LabelChips labels={labels} onRemove={remove} disabled={isPending} />
      )}
      <Autocomplete
        freeSolo
        size="small"
        disabled={isPending}
        options={suggestions.filter((label) => !labels.includes(label))}
        inputValue={draft}
        value={null}
        onInputChange={(_event, value) => {
          setDraft(value);
        }}
        onChange={(_event, value) => {
          if (typeof value === "string") add(value);
        }}
        renderInput={(params) => (
          <TextField {...params} placeholder="Add label" label="Add label" />
        )}
      />
      {actionError ? (
        <Box>
          <Typography variant="caption" color="error">
            {actionError}
          </Typography>
        </Box>
      ) : null}
    </Stack>
  );
}

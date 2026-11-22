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
import type {
  AutomationContract,
  WorkItemAutomationContract,
  WorkItemContract,
} from "@scarn/api/frontend-contracts";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";
import { fetchProjectAutomations } from "@/app/(protected)/projects/_lib/project-work-items";
import {
  useHasProjectPermission,
  useIsProjectMember,
} from "@/components/project-route-context";

const automationName = (automation: AutomationContract) =>
  automation.title ?? automation.key;

/**
 * The Properties panel's Automations value: the work-item automations
 * attached to this item. A viewer who may update work items can detach them,
 * and attach another of the project's work-item automations while the item
 * is open.
 */
export function WorkItemAutomations({
  projectId,
  workItem,
}: {
  projectId: string;
  workItem: Pick<WorkItemContract, "id" | "state">;
}) {
  const isMember = useIsProjectMember();
  const canUpdate = useHasProjectPermission("work-items:update") && isMember;
  const [attached, setAttached] = useState<WorkItemAutomationContract[] | null>(
    null,
  );
  const [available, setAvailable] = useState<AutomationContract[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPending, startAction] = useTransition();
  const workItemId = workItem.id;

  useEffect(() => {
    let cancelled = false;
    void getBrowserScarnApiClient()
      .api["work-items"]({ workItemId: parseWorkItemId(workItemId) })
      .automations.get()
      .then(({ data }) => {
        if (!cancelled) setAttached(Array.isArray(data) ? data : []);
      });
    return () => {
      cancelled = true;
    };
  }, [workItemId]);

  useEffect(() => {
    if (!canUpdate) return;
    let cancelled = false;
    fetchProjectAutomations(projectId)
      .then((automations) => {
        if (!cancelled) {
          setAvailable(
            automations.filter((automation) => automation.scope === "workItem"),
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canUpdate, projectId]);

  if (attached === null) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }

  const automationsApi = (key: string) =>
    getBrowserScarnApiClient()
      .api["work-items"]({ workItemId: parseWorkItemId(workItemId) })
      .automations({ key });

  const attach = (automation: AutomationContract) => {
    setActionError(null);
    startAction(async () => {
      const { data, error } = await automationsApi(automation.key).post();
      if (error) {
        setActionError(
          parseApiError(error, "Could not attach the automation. Try again."),
        );
        return;
      }
      setAttached((current) =>
        [
          ...(current ?? []).filter(
            (entry) => entry.automation.key !== data.automation.key,
          ),
          data,
        ].sort((a, b) => a.automation.key.localeCompare(b.automation.key)),
      );
    });
  };

  const detach = (key: string) => {
    setActionError(null);
    startAction(async () => {
      const { error } = await automationsApi(key).delete();
      if (error) {
        setActionError(
          parseApiError(error, "Could not detach the automation. Try again."),
        );
        return;
      }
      setAttached((current) =>
        (current ?? []).filter((entry) => entry.automation.key !== key),
      );
    });
  };

  const attachedKeys = new Set(attached.map((entry) => entry.automation.key));
  const options = available.filter(
    (automation) => !attachedKeys.has(automation.key),
  );
  const canAttach = canUpdate && workItem.state === "open";

  return (
    <Stack spacing={0.75}>
      {attached.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          None
        </Typography>
      ) : (
        <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
          {attached.map(({ automation }) => (
            <Chip
              key={automation.key}
              label={automationName(automation)}
              size="small"
              variant="outlined"
              disabled={isPending}
              onDelete={
                canUpdate
                  ? () => {
                      detach(automation.key);
                    }
                  : undefined
              }
              deleteIcon={
                <CancelIcon
                  aria-label={`Detach automation ${automationName(automation)}`}
                />
              }
              sx={{ height: 22, color: "text.secondary" }}
            />
          ))}
        </Stack>
      )}
      {canAttach && options.length > 0 ? (
        <Autocomplete
          size="small"
          disabled={isPending}
          options={options}
          value={null}
          getOptionLabel={automationName}
          isOptionEqualToValue={(option, value) => option.key === value.key}
          onChange={(_event, value) => {
            if (value) attach(value);
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              placeholder="Attach automation"
              label="Attach automation"
            />
          )}
        />
      ) : null}
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

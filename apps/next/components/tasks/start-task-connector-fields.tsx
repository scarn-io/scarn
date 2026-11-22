"use client";

/**
 * The start dialog's Connectors multi-select and the secret-name fields of
 * each extra connector. Connectors the environment or the step already has
 * are shown checked and locked, with where they come from.
 */
import AddIcon from "@mui/icons-material/Add";
import {
  Autocomplete,
  Checkbox,
  IconButton,
  ListItemText,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
} from "@mui/material";
import {
  secretNameFor,
  secretNameStatus,
  varsToName,
  type CatalogConnector,
  type EnvironmentFacts,
  type ExtraVarDrafts,
  type LockedConnector,
} from "./start-task-environment";

const STATUS_TEXT = {
  missing: "Name a project secret.",
  invalid: "Use uppercase letters, digits and underscores.",
  saved: "Saved project secret.",
  worker: "Not saved in Scarn: required from worker.",
} as const;

export function StartTaskConnectorsField({
  catalog,
  locked,
  extras,
  error,
  onChange,
}: {
  catalog: readonly CatalogConnector[];
  locked: readonly LockedConnector[];
  extras: readonly string[];
  error: string | undefined;
  onChange: (extras: string[]) => void;
}) {
  const lockedById = new Map(locked.map((entry) => [entry.id, entry.note]));
  const nameOf = (id: string) =>
    catalog.find((connector) => connector.id === id)?.name ?? id;
  const lockedIds = locked.map((entry) => entry.id);
  const unknownLocked = lockedIds.filter(
    (id) => !catalog.some((connector) => connector.id === id),
  );
  return (
    <TextField
      select
      label="Connectors"
      value={[...lockedIds, ...extras]}
      error={error !== undefined}
      helperText={error ?? "Add catalog connectors for this Task only."}
      onChange={(event) => {
        const chosen = event.target.value as unknown as string[];
        onChange(chosen.filter((id) => !lockedById.has(id)));
      }}
      slotProps={{
        select: {
          multiple: true,
          displayEmpty: true,
          renderValue: (selected) => {
            const ids = selected as string[];
            return ids.length > 0 ? ids.map(nameOf).join(", ") : "None";
          },
        },
        inputLabel: { shrink: true },
      }}
    >
      {[...catalog.map((connector) => connector.id), ...unknownLocked].map(
        (id) => {
          const note = lockedById.get(id);
          return (
            <MenuItem key={id} value={id} disabled={note !== undefined}>
              <Checkbox
                size="small"
                checked={note !== undefined || extras.includes(id)}
              />
              <ListItemText primary={nameOf(id)} secondary={note} />
            </MenuItem>
          );
        },
      )}
    </TextField>
  );
}

/**
 * One field per required var. With `onAddSecret`, a var whose name isn't a
 * saved secret yet offers to save one under that name (or the var's name).
 */
export function StartTaskConnectorVarFields({
  catalog,
  extras,
  environment,
  drafts,
  savedSecretNames,
  errors,
  onChange,
  onAddSecret,
}: {
  catalog: readonly CatalogConnector[];
  extras: readonly string[];
  environment: EnvironmentFacts | null;
  drafts: ExtraVarDrafts;
  savedSecretNames: readonly string[];
  errors: Record<string, Record<string, string>> | undefined;
  onChange: (connectorId: string, varName: string, secret: string) => void;
  onAddSecret?: (connectorId: string, varName: string, name: string) => void;
}) {
  const fields = extras.flatMap((connectorId) => {
    const connector = catalog.find((entry) => entry.id === connectorId);
    return varsToName(connector, environment).map((varName) => ({
      connectorId,
      connectorName: connector?.name ?? connectorId,
      varName,
    }));
  });
  if (fields.length === 0) return null;
  return (
    <Stack spacing={2}>
      {fields.map(({ connectorId, connectorName, varName }) => {
        const value = secretNameFor(
          drafts,
          connectorId,
          varName,
          savedSecretNames,
        );
        const serverError = errors?.[connectorId]?.[varName];
        const status = secretNameStatus(value, savedSecretNames);
        const canAdd =
          onAddSecret !== undefined &&
          (status === "worker" || status === "missing");
        return (
          <Stack
            key={`${connectorId}/${varName}`}
            direction="row"
            spacing={1}
            sx={{ alignItems: "flex-start" }}
          >
            <Autocomplete
              sx={{ flex: 1 }}
              freeSolo
              size="small"
              options={savedSecretNames}
              inputValue={value}
              value={null}
              onInputChange={(_event, next) => {
                onChange(connectorId, varName, next);
              }}
              onChange={(_event, next) => {
                if (typeof next === "string")
                  onChange(connectorId, varName, next);
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={`${connectorName}: ${varName}`}
                  error={
                    serverError !== undefined ||
                    status === "missing" ||
                    status === "invalid"
                  }
                  helperText={serverError ?? STATUS_TEXT[status]}
                />
              )}
            />
            {canAdd ? (
              <Tooltip title="Add secret">
                <IconButton
                  size="small"
                  sx={{ mt: 0.5, flexShrink: 0 }}
                  aria-label={`Add secret for ${connectorName}: ${varName}`}
                  onClick={() => {
                    onAddSecret(connectorId, varName, value.trim() || varName);
                  }}
                >
                  <AddIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}

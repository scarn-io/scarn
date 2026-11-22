import {
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  TextField,
} from "@mui/material";
import {
  MANAGED_RUNTIME_IDS,
  type ManagedRuntimeId,
} from "@scarn/sdk/managed-runtimes";

export type StepRuntimeKind =
  "repo-default" | "named" | "devcontainer" | "managed" | "host";

export function StepRuntimeField({
  kind,
  isCode,
  onChange,
}: {
  kind: StepRuntimeKind;
  isCode: boolean;
  onChange: (kind: StepRuntimeKind) => void;
}) {
  return (
    <FormControl fullWidth>
      <InputLabel>Runtime</InputLabel>
      <Select
        label="Runtime"
        value={kind}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        <MenuItem value="repo-default">Repository default</MenuItem>
        <MenuItem value="named">Named environment</MenuItem>
        <MenuItem value="devcontainer">Devcontainer</MenuItem>
        <MenuItem value="managed">Managed container</MenuItem>
        <MenuItem value="host" disabled={isCode}>
          Host
        </MenuItem>
      </Select>
      <FormHelperText>
        Every runtime checks out your repository. Host runs directly on the
        worker without a container. Repository access is preserved when changing
        runtimes.
      </FormHelperText>
    </FormControl>
  );
}

export function StepManagedRuntimeField({
  runtime,
  onChange,
}: {
  runtime: ManagedRuntimeId;
  onChange: (runtime: ManagedRuntimeId) => void;
}) {
  return (
    <FormControl fullWidth>
      <InputLabel>Managed runtime</InputLabel>
      <Select
        label="Managed runtime"
        value={runtime}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        {MANAGED_RUNTIME_IDS.map((id) => (
          <MenuItem key={id} value={id}>
            {id}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

export function StepEnvironmentNameField({
  name,
  error,
  onChange,
}: {
  name: string;
  error?: string | undefined;
  onChange: (name: string) => void;
}) {
  return (
    <TextField
      label="Environment name"
      value={name}
      onChange={(e) => {
        onChange(e.target.value);
      }}
      required
      fullWidth
      error={Boolean(error)}
      helperText={error ?? "The name of an environment published to this project."}
    />
  );
}

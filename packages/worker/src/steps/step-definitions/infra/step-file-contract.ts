import type { EnvVarSpec } from "@scarn/sdk/env-vars";
import type { RepoConfig } from "@scarn/sdk/repo-config";
import type { Grant } from "@scarn/sdk/definitions/steps";

export type StepDefContract = {
  key: string;
  name: string;
  description: string | null;
  prompt: string | null;
  version: number;
  status: string;
  kind?: "built_in" | "user_defined" | "code";
  environment:
    | null
    | {
        kind: "inline";
        runtime?:
          | { kind: "host" }
          | { kind: "managed"; id: string }
          | { kind: "devcontainer"; config?: string };
        envJson?: EnvVarSpec[] | null;
        connectors?: string[];
      }
    | { kind: "named"; name: string };
  repo: RepoConfig;
  inputSchemaJson: Record<string, unknown> | null;
  resultSchemaJson: Record<string, unknown> | null;
  opencodeMcpJson: Record<string, unknown> | null;
  healthChecksJson: unknown[] | null;
  errors?: string[];
  retry?: { on: string[]; maxAttempts: number }[];
  maxTurns?: number | null;
  grants?: readonly Grant[];
};

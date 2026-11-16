import { resolveRepoConfig } from "@scarn/sdk/repo-config";
import type { StepDefContract } from "../../../../src/steps/step-definitions/infra/step-file-generator";

export function makeStep(
  overrides: Partial<StepDefContract> = {},
): StepDefContract {
  return {
    key: "browser-repro",
    name: "Browser Repro",
    description: null,
    prompt: "Open the app.",
    version: 1,
    status: "active",
    environment: null,
    repo: resolveRepoConfig(),
    inputSchemaJson: null,
    resultSchemaJson: null,
    opencodeMcpJson: null,
    healthChecksJson: null,
    ...overrides,
  };
}

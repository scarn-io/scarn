import type {
  AnyJsonObject,
  StepDefinitionContract,
} from "@scarn/api/frontend-contracts";
import type { ManagedRuntimeId } from "@scarn/sdk/managed-runtimes";
import { environmentNameSchema } from "@scarn/sdk/environment";

export function editStepEnvironment(
  original: StepDefinitionContract["environment"],
  selection: {
    edited: boolean;
    kind: "repo-default" | "named" | "host" | "devcontainer" | "managed";
    managedRuntime: ManagedRuntimeId;
    environmentName?: string;
    resetInline?: boolean;
  },
): StepDefinitionContract["environment"] {
  if (!selection.edited) return original;
  if (selection.kind === "named") {
    const parsed = environmentNameSchema.safeParse(selection.environmentName);
    if (!parsed.success) {
      throw new Error(
        "Environment name must start with a lowercase letter or digit and contain only lowercase letters, digits, and hyphens",
      );
    }
    return { kind: "named", name: parsed.data };
  }
  const inline =
    !selection.resetInline && original?.kind === "inline" ? original : null;
  const runtime =
    selection.kind === "repo-default"
      ? undefined
      : selection.kind === "managed"
        ? { kind: "managed" as const, id: selection.managedRuntime }
        : selection.kind === "devcontainer"
          ? {
              kind: "devcontainer" as const,
              ...(inline?.runtime?.kind === "devcontainer" &&
              inline.runtime.config !== undefined
                ? { config: inline.runtime.config }
                : {}),
            }
          : { kind: "host" as const };
  return runtime === undefined && inline?.envJson === undefined
    ? null
    : { ...inline, kind: "inline", runtime };
}

/** The repo settings the step dialog edits. */
export type StepRepoSettings = {
  mode: "readOnly" | "readWrite";
  gitCredentials: "auto" | "none";
  baseBranch: string;
  workBranch: "create" | "base";
};

export const defaultStepRepoSettings: StepRepoSettings = {
  mode: "readWrite",
  gitCredentials: "auto",
  baseBranch: "",
  workBranch: "create",
};

export function stepRepoSettingsOf(
  repo: StepDefinitionContract["repo"],
): StepRepoSettings {
  return {
    mode: repo.mode,
    gitCredentials: repo.gitCredentials,
    baseBranch: repo.baseBranch ?? "",
    workBranch: repo.mode === "readWrite" ? repo.workBranch.kind : "create",
  };
}

/**
 * The repo to save: the dialog's settings, keeping a readWrite step's commit
 * message and push failure policy, which the dialog does not edit. A blank
 * base branch saves as `null`.
 */
export function editStepRepo(
  original: StepDefinitionContract["repo"] | undefined,
  settings: StepRepoSettings,
): StepDefinitionContract["repo"] {
  const shared = {
    gitCredentials: settings.gitCredentials,
    baseBranch: settings.baseBranch.trim() || null,
  };
  return settings.mode === "readOnly"
    ? { mode: "readOnly", ...shared }
    : {
        mode: "readWrite",
        ...shared,
        message: original?.mode === "readWrite" ? original.message : null,
        onPushFailure:
          original?.mode === "readWrite" ? original.onPushFailure : "fail",
        workBranch: { kind: settings.workBranch },
      };
}

export const toKey = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export function parseJsonField(value: string, label: string): AnyJsonObject {
  try {
    return JSON.parse(value) as AnyJsonObject;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

/** The schema a blank schema field saves as: an object with no declared fields. */
export const emptyObjectSchema = (): AnyJsonObject => ({
  type: "object",
  properties: {},
});

import {
  artifactPlatforms,
  EMBEDDABLE_ARTIFACT_EXTENSIONS,
  findArtifactFields,
} from "../../contracts/artifacts";
import { findArtifactMarkers } from "../../contracts/artifact-markers";
import type { StepDefinitionSpec } from "../steps/define-step";
import { listPaths, type DefinitionValidationIssue } from "./validation-issue";

type StepMarker = {
  readonly kind: "embed" | "link";
  readonly stepKey: string;
  readonly resultPath: string;
};

const isPlaceholder = (key: string): boolean => /^<[^<>]*>$/.test(key);

/**
 * Step markers (`artifact:signal/<stepKey>/<resultPath>`) in a step's
 * prompt. `Artifact.embed` / `Artifact.link` produce marker strings, and the
 * prompt is the only place a definition carries them. A marker whose keys are
 * `<...>` placeholders documents the format (the notifications feature's
 * prompt does) and points at nothing.
 */
function stepMarkers(step: StepDefinitionSpec): StepMarker[] {
  if (!step.prompt) return [];
  return findArtifactMarkers(step.prompt).flatMap((marker) =>
    marker.ref.type === "signal" &&
    !isPlaceholder(marker.ref.stepKey) &&
    !isPlaceholder(marker.ref.signalKey)
      ? [
          {
            kind: marker.kind,
            stepKey: marker.ref.stepKey,
            resultPath: marker.ref.signalKey,
          },
        ]
      : [],
  );
}

const markerLabel = (marker: StepMarker): string =>
  `${marker.kind === "embed" ? "Artifact.embed" : "Artifact.link"}(` +
  `"signal/${marker.stepKey}/${marker.resultPath}")`;

/**
 * Check: a step marker names an artifact field in that step's result, and an
 * embed marker points at a field some platform can show inline. Only steps in
 * this batch that declare a result schema can be checked.
 */
function checkMarkerTargets(
  steps: readonly StepDefinitionSpec[],
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
): DefinitionValidationIssue[] {
  const issues: DefinitionValidationIssue[] = [];
  const embeddable = new Set(
    artifactPlatforms.flatMap((platform) => [
      ...EMBEDDABLE_ARTIFACT_EXTENSIONS[platform],
    ]),
  );

  for (const step of steps) {
    for (const marker of stepMarkers(step)) {
      const targets = stepsByKey.get(marker.stepKey);
      if (!targets) continue;
      const where = `Step "${step.key}" uses ${markerLabel(marker)}`;

      for (const target of targets) {
        if (!target.resultSchemaJson) continue;
        const fields = findArtifactFields(target.resultSchemaJson);
        const field = fields.find(
          (candidate) => candidate.path === marker.resultPath,
        );
        if (!field) {
          const declared = fields.map((candidate) => candidate.path);
          issues.push({
            check: "artifact-marker",
            severity: "error",
            message:
              `${where}, but step "${target.key}" has no artifact field at ` +
              `"${marker.resultPath}". Artifact fields on "${target.key}": ` +
              `${declared.length > 0 ? listPaths(declared) : "(none)"}.`,
          });
          continue;
        }

        if (marker.kind !== "embed") continue;
        const { accept } = field;
        if (accept.length === 0) continue;
        if (accept.some((extension) => embeddable.has(extension))) continue;
        issues.push({
          check: "artifact-marker",
          severity: "warning",
          message:
            `${where}, but the field accepts only ${accept.join(", ")}, which ` +
            `no platform can embed, so it will always be linked. Embeddable ` +
            `extensions: ${[...embeddable].join(", ")}.`,
        });
      }
    }
  }

  return issues;
}

export function checkArtifactMarkers(
  steps: readonly StepDefinitionSpec[],
  stepsByKey: Map<string, readonly StepDefinitionSpec[]>,
): DefinitionValidationIssue[] {
  return checkMarkerTargets(steps, stepsByKey);
}

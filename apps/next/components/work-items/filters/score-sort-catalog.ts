import type {
  AnyJsonObject,
  AnyJsonValue,
  PipelineDefinitionContract,
  StepDefinitionContract,
  UuidV7,
} from "@scarn/api/frontend-contracts";

/**
 * What the score sort can sort by: for each active pipeline, the steps its
 * current version pins and the number fields in each step's result schema.
 * A `score:<pipeline>:<step>:<result path>` token is one leaf of this tree.
 */
export type ScoreSortStep = {
  stepKey: string;
  name: string;
  resultPaths: string[];
};

export type ScoreSortPipeline = {
  id: UuidV7;
  name: string;
  steps: ScoreSortStep[];
};

const MAX_SCHEMA_DEPTH = 8;

const isRecord = (value: AnyJsonValue | undefined): value is AnyJsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNumberSchema = (schema: AnyJsonObject): boolean => {
  const { type } = schema;
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => entry === "number" || entry === "integer");
};

/**
 * Dotted paths to every number field in a JSON Schema, following nested
 * object `properties` only — array items have no stable path to sort on.
 */
export const numberResultPaths = (schema: AnyJsonValue): string[] => {
  const paths: string[] = [];
  const walk = (node: AnyJsonValue | undefined, prefix: string[]) => {
    if (!isRecord(node) || prefix.length > MAX_SCHEMA_DEPTH) return;
    if (prefix.length > 0 && isNumberSchema(node)) {
      paths.push(prefix.join("."));
      return;
    }
    const properties = node["properties"];
    if (!isRecord(properties)) return;
    for (const [key, child] of Object.entries(properties)) {
      walk(child, [...prefix, key]);
    }
  };
  walk(schema, []);
  return paths;
};

/** Active pipelines with at least one step that has a sortable number field. */
export const buildScoreSortCatalog = (
  definitions: readonly PipelineDefinitionContract[],
  stepDefinitions: readonly StepDefinitionContract[],
): ScoreSortPipeline[] => {
  const stepsById = new Map(stepDefinitions.map((step) => [step.id, step]));
  const latestByKey = new Map<string, StepDefinitionContract>();
  for (const step of stepDefinitions) {
    const current = latestByKey.get(step.key);
    if (!current || step.version > current.version) {
      latestByKey.set(step.key, step);
    }
  }
  return definitions.flatMap((definition) => {
    if (definition.archivedAt !== null || !definition.currentVersion) {
      return [];
    }
    const steps = definition.currentVersion.steps.flatMap(
      ({ stepKey, stepDefinitionId }) => {
        const step =
          stepsById.get(stepDefinitionId) ?? latestByKey.get(stepKey);
        const resultPaths = step
          ? numberResultPaths(step.resultSchemaJson)
          : [];
        return resultPaths.length > 0
          ? [{ stepKey, name: step?.name ?? stepKey, resultPaths }]
          : [];
      },
    );
    return steps.length > 0
      ? [{ id: definition.id, name: definition.name, steps }]
      : [];
  });
};

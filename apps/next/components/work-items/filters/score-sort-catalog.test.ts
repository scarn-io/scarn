import { describe, expect, it } from "bun:test";
import type {
  PipelineDefinitionContract,
  StepDefinitionContract,
  UuidV7,
} from "@scarn/api/frontend-contracts";
import { buildScoreSortCatalog, numberResultPaths } from "./score-sort-catalog";

const id = (suffix: string) =>
  `018f0000-0000-7000-8000-${suffix.padStart(12, "0")}` as UuidV7;

const step = (
  overrides: Pick<StepDefinitionContract, "key" | "name" | "version"> & {
    id: UuidV7;
    resultSchemaJson: Record<string, unknown>;
  },
) => overrides as unknown as StepDefinitionContract;

const pipeline = (overrides: {
  id: UuidV7;
  name: string;
  archivedAt?: string | null;
  steps: Array<{ stepKey: string; stepDefinitionId: UuidV7 }> | null;
}): PipelineDefinitionContract =>
  ({
    id: overrides.id,
    name: overrides.name,
    archivedAt: overrides.archivedAt ?? null,
    currentVersion: overrides.steps ? { steps: overrides.steps } : null,
  }) as unknown as PipelineDefinitionContract;

describe("numberResultPaths", () => {
  it("lists nested number and integer fields as dotted paths", () => {
    expect(
      numberResultPaths({
        type: "object",
        properties: {
          score: { type: "number" },
          label: { type: "string" },
          detail: {
            type: "object",
            properties: {
              confidence: { type: ["integer", "null"] },
              items: { type: "array", items: { type: "number" } },
            },
          },
        },
      }),
    ).toEqual(["score", "detail.confidence"]);
  });

  it("ignores a root number schema and non-object input", () => {
    expect(numberResultPaths({ type: "number" })).toEqual([]);
    expect(numberResultPaths(null)).toEqual([]);
  });
});

describe("buildScoreSortCatalog", () => {
  const scored = step({
    id: id("1"),
    key: "triage",
    name: "Triage",
    version: 1,
    resultSchemaJson: {
      type: "object",
      properties: { score: { type: "number" } },
    },
  });
  const unscored = step({
    id: id("2"),
    key: "notes",
    name: "Notes",
    version: 1,
    resultSchemaJson: { type: "object", properties: {} },
  });

  it("keeps only active pipelines with pinned steps that have number fields", () => {
    const catalog = buildScoreSortCatalog(
      [
        pipeline({
          id: id("a"),
          name: "Main",
          steps: [
            { stepKey: "triage", stepDefinitionId: scored.id },
            { stepKey: "notes", stepDefinitionId: unscored.id },
          ],
        }),
        pipeline({
          id: id("b"),
          name: "Archived",
          archivedAt: "2026-01-01T00:00:00.000Z",
          steps: [{ stepKey: "triage", stepDefinitionId: scored.id }],
        }),
        pipeline({ id: id("c"), name: "Unpublished", steps: null }),
        pipeline({
          id: id("d"),
          name: "Notes only",
          steps: [{ stepKey: "notes", stepDefinitionId: unscored.id }],
        }),
      ],
      [scored, unscored],
    );

    expect(catalog).toEqual([
      {
        id: id("a"),
        name: "Main",
        steps: [{ stepKey: "triage", name: "Triage", resultPaths: ["score"] }],
      },
    ]);
  });

  it("falls back to the latest step version by key when the pinned id is unknown", () => {
    const newer = step({
      id: id("3"),
      key: "triage",
      name: "Triage v2",
      version: 2,
      resultSchemaJson: {
        type: "object",
        properties: { risk: { type: "integer" } },
      },
    });

    const catalog = buildScoreSortCatalog(
      [
        pipeline({
          id: id("a"),
          name: "Main",
          steps: [{ stepKey: "triage", stepDefinitionId: id("99") }],
        }),
      ],
      [scored, newer],
    );

    expect(catalog[0]?.steps).toEqual([
      { stepKey: "triage", name: "Triage v2", resultPaths: ["risk"] },
    ]);
  });
});

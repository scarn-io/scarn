import { describe, expect } from "bun:test";
import { pipelineDocumentSchema } from "@scarn/sdk/contracts/pipeline-document";
import {
  CURRENT_PIPELINE_GRAPH_VERSION_SCHEMA_VERSION,
  readStoredPipelineDocument,
  type StoredPipelineGraphVersionColumns,
} from "@/pipeline-definitions/pipeline-graph/contracts/pipeline-graph-version-stored";
import { pipelineGraphVersionFromRow } from "@/pipeline-definitions/pipeline-graph/infra/drizzle-pipeline-graph-version-repo";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import v1MultiNodeFixture from "../fixtures/v1-multi-node.json";
import v1WayfinderFixture from "../fixtures/v1-wayfinder.json";

const fixtures = [
  ["multi-node", v1MultiNodeFixture],
  ["wayfinder", v1WayfinderFixture],
] as const;

const versionRow = (
  schemaVersion: number,
  { definitionJson }: StoredPipelineGraphVersionColumns,
) => ({
  id: createUuidV7(),
  pipelineGraphId: createUuidV7(),
  version: 1,
  definitionJson,
  schemaVersion,
  contentHash: "hash",
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
});

describe("pipeline graph version stored read", () => {
  for (const [name, fixture] of fixtures) {
    concurrentTest(`reads the v1 ${name} fixture as stored`, () => {
      const read = readStoredPipelineDocument(fixture.schemaVersion, fixture);
      if (!read.success) throw new Error(read.reason);
      expect<object>(read.value).toEqual(fixture.definitionJson);
    });

    concurrentTest(`the v1 ${name} fixture still passes the SDK schema`, () => {
      expect(
        pipelineDocumentSchema.safeParse(fixture.definitionJson).success,
      ).toBe(true);
    });

    concurrentTest(
      `reads the v1 ${name} fixture through the row mapper`,
      () => {
        const version = pipelineGraphVersionFromRow(
          versionRow(fixture.schemaVersion, fixture),
        );
        expect<object>(version.definitionJson).toEqual(fixture.definitionJson);
      },
    );
  }

  concurrentTest(
    "does not reapply publish rules (node id pattern, condition grammar, empty strings, enums)",
    () => {
      const read = readStoredPipelineDocument(1, {
        definitionJson: {
          schemaVersion: 1,
          key: "",
          start: { to: "has spaces", args: { "": "" } },
          nodes: {
            "has spaces": {
              kind: "step",
              step: "",
              maxTurns: -1,
              next: {
                match: "some-future-mode",
                routes: [],
                otherwise: { to: "wait", each: { over: "x" }, partial: true },
              },
            },
            wait: {
              kind: "wait",
              for: "webhook",
              actions: [{ key: "", label: "", body: "forbidden" }],
              next: {
                routes: [{ when: { path: "a", op: "bogus" }, to: "done" }],
              },
            },
            done: { kind: "fail", error: "" },
          },
        },
      });
      expect(read.success).toBe(true);
    },
  );

  concurrentTest("keeps keys the frozen shape doesn't name", () => {
    const read = readStoredPipelineDocument(1, {
      definitionJson: {
        ...v1WayfinderFixture.definitionJson,
        futureTopLevel: true,
        nodes: {
          ...v1WayfinderFixture.definitionJson.nodes,
          done: { kind: "succeed", futureNodeKey: 1 },
        },
      },
    });
    if (!read.success) throw new Error(read.reason);
    expect(read.value).toHaveProperty("futureTopLevel", true);
    expect(read.value.nodes["done"]).toHaveProperty("futureNodeKey", 1);
  });

  concurrentTest("rejects an unknown schema version", () => {
    const read = readStoredPipelineDocument(
      CURRENT_PIPELINE_GRAPH_VERSION_SCHEMA_VERSION + 1,
      v1WayfinderFixture,
    );
    expect(read.success).toBe(false);
  });

  concurrentTest("rejects a structurally broken document", () => {
    const read = readStoredPipelineDocument(1, {
      definitionJson: {
        schemaVersion: 1,
        key: "broken",
        start: { to: "a" },
        nodes: { a: { kind: "step" } },
      },
    });
    expect(read.success).toBe(false);
  });

  concurrentTest("the row mapper fails on an unreadable document", () => {
    expect(() =>
      pipelineGraphVersionFromRow(
        versionRow(1, { definitionJson: { kind: "automation" } }),
      ),
    ).toThrow(/unreadable/);
  });
});

import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import { PipelineGraphEntity } from "@/pipeline-definitions/pipeline-graph/domain/pipeline-graph-entity";
import { CoreValidationError } from "@/lib/errors";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f10");
const currentVersionId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f11");

const baseCreateProps = {
  projectId,
  key: "code_review",
  name: "Code Review",
};

describe("pipeline graph entity", () => {
  concurrentTest("throws when key is empty or whitespace-only", () => {
    expect(() =>
      PipelineGraphEntity.create({ ...baseCreateProps, key: "   " }),
    ).toThrow(CoreValidationError);

    try {
      PipelineGraphEntity.create({ ...baseCreateProps, key: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe(
        "PIPELINE_GRAPH_KEY_REQUIRED",
      );
    }
  });

  concurrentTest("throws when name is empty or whitespace-only", () => {
    try {
      PipelineGraphEntity.create({ ...baseCreateProps, name: "  " });
    } catch (error) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe(
        "PIPELINE_GRAPH_NAME_REQUIRED",
      );
    }
  });

  concurrentTest("create generates an id and defaults isArchived to false", () => {
    const graph = PipelineGraphEntity.create(baseCreateProps);

    expect(graph.id).toBeString();
    expect(graph.isArchived).toBe(false);
    expect(graph.currentVersionId).toBeNull();
    expect(graph.projectId).toBe(projectId);
    expect(graph.key).toBe("code_review");
    expect(graph.name).toBe("Code Review");
  });

  concurrentTest("rename produces a new entity with updated name and updatedAt", () => {
    const original = PipelineGraphEntity.create(baseCreateProps);
    const now = new Date("2026-04-22T12:00:00.000Z");
    const renamed = original.rename("Renamed Pipeline", now);

    expect(renamed).not.toBe(original);
    expect(renamed.id).toBe(original.id);
    expect(renamed.name).toBe("Renamed Pipeline");
    expect(renamed.updatedAt).toEqual(now);
    expect(original.name).toBe("Code Review");
  });

  concurrentTest("withCurrentVersionId sets currentVersionId", () => {
    const original = PipelineGraphEntity.create(baseCreateProps);
    const now = new Date("2026-04-22T12:00:00.000Z");
    const updated = original.withCurrentVersionId(currentVersionId, now);

    expect(updated.currentVersionId).toBe(currentVersionId);
    expect(original.currentVersionId).toBeNull();
  });

  concurrentTest("archive and unarchive toggle isArchived", () => {
    const original = PipelineGraphEntity.create(baseCreateProps);
    const now = new Date("2026-04-22T12:00:00.000Z");

    const archived = original.archive(now);
    expect(archived.isArchived).toBe(true);
    expect(archived.archivedAt).toEqual(now);
    expect(original.isArchived).toBe(false);

    const unarchived = archived.unarchive(now);
    expect(unarchived.isArchived).toBe(false);
  });

  concurrentTest("rehydrate preserves persisted fields", () => {
    const graph = PipelineGraphEntity.rehydrate({
      id: "0196917c-532c-75aa-b7d5-0a84b71a1f12" as never,
      projectId,
      key: "code_review",
      name: "Code Review",
      currentVersionId,
      archivedAt: null,
      createdAt: "2026-04-22T12:00:00.000Z",
      updatedAt: "2026-04-22T12:05:00.000Z",
    });

    expect(graph.currentVersionId).toBe(currentVersionId);
    expect(graph.createdAt).toEqual(new Date("2026-04-22T12:00:00.000Z"));
    expect(graph.updatedAt).toEqual(new Date("2026-04-22T12:05:00.000Z"));
  });
});

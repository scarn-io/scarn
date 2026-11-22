import { describe, expect } from "bun:test";
import {
  CURRENT_ENVIRONMENT_CONTENT_SCHEMA_VERSION,
  readStoredEnvironmentContent,
} from "@/pipeline-definitions/environment/contracts/environment-content-stored";
import { environmentVersionFromRow } from "@/pipeline-definitions/environment/infra/drizzle-environment-repo";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { concurrentTest } from "tests/utils";
import v1Fixture from "../fixtures/v1.json";

describe("environment content stored read", () => {
  concurrentTest("reads the v1 fixture as stored", () => {
    const read = readStoredEnvironmentContent(
      v1Fixture.schemaVersion,
      v1Fixture,
    );
    if (!read.success) throw new Error(read.reason);
    expect<object>(read.content).toEqual(v1Fixture.contentJson);
  });

  concurrentTest("reads the v1 fixture through the row mapper", () => {
    const version = environmentVersionFromRow({
      id: createUuidV7(),
      environmentId: createUuidV7(),
      version: 3,
      schemaVersion: v1Fixture.schemaVersion,
      contentJson: v1Fixture.contentJson,
      contentHash: "hash",
      createdByUserId: createUuidV7(),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect<object>(version.content).toEqual(v1Fixture.contentJson);
  });

  concurrentTest(
    "does not reapply write rules (unknown connector, missing vars)",
    () => {
      const read = readStoredEnvironmentContent(1, {
        contentJson: { connectors: ["retired-connector"] },
      });
      expect(read).toEqual({
        success: true,
        content: { connectors: ["retired-connector"] },
      });
    },
  );

  concurrentTest(
    "strips a branch from content stored before it was removed",
    () => {
      const read = readStoredEnvironmentContent(1, {
        contentJson: { description: "Frontend", branch: "main" },
      });
      expect(read).toEqual({
        success: true,
        content: { description: "Frontend" },
      });
    },
  );

  concurrentTest("reads a var without applies as agent", () => {
    const read = readStoredEnvironmentContent(1, {
      contentJson: {
        vars: [{ name: "A", source: "value", value: "1", secret: false }],
      },
    });
    if (!read.success) throw new Error(read.reason);
    expect(read.content.vars?.[0]?.applies).toBe("agent");
  });

  concurrentTest("rejects an unknown schema version", () => {
    const read = readStoredEnvironmentContent(
      CURRENT_ENVIRONMENT_CONTENT_SCHEMA_VERSION + 1,
      { contentJson: {} },
    );
    expect(read.success).toBe(false);
  });

  concurrentTest("the row mapper fails on unreadable content", () => {
    expect(() =>
      environmentVersionFromRow({
        id: createUuidV7(),
        environmentId: createUuidV7(),
        version: 1,
        schemaVersion: 1,
        contentJson: { runtime: { kind: "spaceship" } },
        contentHash: "hash",
        createdByUserId: createUuidV7(),
        createdAt: new Date(),
      }),
    ).toThrow(/unreadable/);
  });
});

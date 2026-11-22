import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { EnvironmentEntity } from "@/pipeline-definitions/environment/domain/environment-entity";
import { CoreValidationError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";

const created = new Date("2026-01-01T00:00:00.000Z");
const later = new Date("2026-01-02T00:00:00.000Z");

const create = (name = "frontend") =>
  EnvironmentEntity.create({ projectId: createUuidV7(), name, now: created });

describe("EnvironmentEntity", () => {
  concurrentTest("starts with no versions", () => {
    const environment = create();
    expect(environment.latestVersion).toBe(0);
    expect(environment.nextVersion).toBe(1);
    expect(environment.isDeleted).toBe(false);
  });

  concurrentTest.each(["Frontend", "-frontend", "front_end", ""])(
    "rejects the name %p",
    (name) => {
      expect(() => create(name)).toThrow(CoreValidationError);
    },
  );

  concurrentTest("publishVersion takes the next number", () => {
    const published = create().publishVersion(1, later);
    expect(published.latestVersion).toBe(1);
    expect(published.updatedAt).toBe(later);
    expect(() => published.publishVersion(3, later)).toThrow(
      CoreValidationError,
    );
  });

  concurrentTest(
    "delete keeps the latest version, and publishing restores it",
    () => {
      const deleted = create().publishVersion(1, created).delete(later);
      expect(deleted.isDeleted).toBe(true);
      expect(deleted.latestVersion).toBe(1);

      const republished = deleted.publishVersion(2, later);
      expect(republished.isDeleted).toBe(false);
      expect(republished.latestVersion).toBe(2);
    },
  );

  concurrentTest("restore clears deletedAt without a new version", () => {
    const restored = create()
      .publishVersion(1, created)
      .delete(later)
      .restore(later);
    expect(restored.isDeleted).toBe(false);
    expect(restored.latestVersion).toBe(1);
  });
});

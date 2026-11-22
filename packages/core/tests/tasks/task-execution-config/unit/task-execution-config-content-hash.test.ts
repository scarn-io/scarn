import { describe, expect } from "bun:test";
import { createHash } from "node:crypto";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { canonicalJson } from "@/lib/canonical-json";
import type { TaskExecutionConfigContentInput } from "@/tasks/task-execution-config/contracts/task-execution-config-contracts";
import { CURRENT_TASK_EXECUTION_CONFIG_SCHEMA_VERSION } from "@/tasks/task-execution-config/contracts/task-execution-config-stored";
import { TaskExecutionConfigEntity } from "@/tasks/task-execution-config/domain/task-execution-config-entity";
import { concurrentTest } from "tests/utils";

const create = (
  content: Partial<TaskExecutionConfigContentInput>,
  projectId = createUuidV7(),
) =>
  TaskExecutionConfigEntity.create({
    projectId,
    content: {
      environment: null,
      git: null,
      mcp: null,
      healthChecks: null,
      ...content,
    },
  });

describe("task execution config content hash (D7)", () => {
  const projectId = createUuidV7();

  concurrentTest("is stable across object key order", () => {
    const first = create(
      {
        environment: {
          kind: "inline",
          runtime: {
            kind: "devcontainer",
            config: ".devcontainer/devcontainer.json",
          },
        },
        mcp: {
          a: { type: "local", command: ["a"], disabled: false },
          b: { type: "ref", name: "b" },
        },
        git: { mode: "readOnly" },
      },
      projectId,
    );
    const second = create(
      {
        git: { mode: "readOnly" },
        mcp: {
          b: { name: "b", type: "ref" },
          a: { disabled: false, command: ["a"], type: "local" },
        },
        environment: {
          runtime: {
            config: ".devcontainer/devcontainer.json",
            kind: "devcontainer",
          },
          kind: "inline",
        },
      },
      projectId,
    );

    expect(second.contentHash()).toBe(first.contentHash());
    expect(first.contentHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  concurrentTest("ignores id and project", () => {
    const content = {
      environment: {
        kind: "inline" as const,
        runtime: { kind: "host" as const },
      },
    };

    expect(create(content).contentHash()).toBe(create(content).contentHash());
  });

  concurrentTest("changes when health-check order changes", () => {
    const cli = { kind: "cli" as const, command: ["gh", "--version"] };
    const other = { kind: "cli" as const, command: ["node", "--version"] };

    expect(create({ healthChecks: [cli, other] }).contentHash()).not.toBe(
      create({ healthChecks: [other, cli] }).contentHash(),
    );
  });

  concurrentTest("changes when content changes", () => {
    expect(
      create({
        environment: { kind: "inline", runtime: { kind: "host" } },
      }).contentHash(),
    ).not.toBe(
      create({
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "bun1" },
        },
      }).contentHash(),
    );
  });

  concurrentTest(
    "hashes a default gitCredentials like a row written before the field",
    () => {
      const environment = {
        kind: "inline" as const,
        runtime: { kind: "managed" as const, id: "bun1" as const },
      };
      const legacyHash = createHash("sha256")
        .update(
          canonicalJson({
            schemaVersion: CURRENT_TASK_EXECUTION_CONFIG_SCHEMA_VERSION,
            environment,
            git: { mode: "readOnly", baseBranch: null },
            mcp: null,
            healthChecks: null,
          }),
        )
        .digest("hex");

      expect(
        create({ environment, git: { mode: "readOnly" } }).contentHash(),
      ).toBe(legacyHash);
      expect(
        create({
          environment,
          git: { mode: "readOnly", gitCredentials: "auto" },
        }).contentHash(),
      ).toBe(legacyHash);
      expect(
        create({
          environment,
          git: { mode: "readOnly", gitCredentials: "none" },
        }).contentHash(),
      ).not.toBe(legacyHash);
    },
  );

  concurrentTest("treats a restated default the same as null", () => {
    expect(
      create({
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "bun1" },
        },
        git: { mode: "readWrite" },
      }).contentHash(),
    ).toBe(
      create({
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "bun1" },
        },
      }).contentHash(),
    );
    expect(
      create({
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "bun1" },
        },
        git: { mode: "readWrite", gitCredentials: "auto" },
      }).git,
    ).toBeNull();
  });
});

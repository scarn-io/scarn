import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import type { TaskExecutionConfigContentInput } from "@/tasks/task-execution-config/contracts/task-execution-config-contracts";
import { TaskExecutionConfigEntity } from "@/tasks/task-execution-config/domain/task-execution-config-entity";
import { concurrentTest } from "tests/utils";

const create = (content: Partial<TaskExecutionConfigContentInput>) =>
  TaskExecutionConfigEntity.create({
    projectId: createUuidV7(),
    content: {
      environment: null,
      git: null,
      mcp: null,
      healthChecks: null,
      ...content,
    },
  });

describe("task execution config entity runtime", () => {
  concurrentTest(
    "preserves explicit pathless devcontainer as an override",
    () => {
      const config = create({
        environment: { kind: "inline", runtime: { kind: "devcontainer" } },
      });
      expect(config.isEmpty()).toBe(false);
      expect(config.environment).toEqual({
        kind: "inline",
        runtime: { kind: "devcontainer" },
      });
      expect(config.contentHash()).not.toBe(create({}).contentHash());
    },
  );

  concurrentTest(
    "preserves an explicit inline host config on current writes",
    () => {
      const config = create({
        environment: { kind: "inline", runtime: { kind: "host" } },
        git: { mode: "readOnly", gitCredentials: "none" },
      });
      expect(config.environment).toEqual({
        kind: "inline",
        runtime: { kind: "host" },
      });
      expect(config.git).toEqual({
        mode: "readOnly",
        gitCredentials: "none",
        baseBranch: null,
      });
    },
  );
});

import { describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { stepDefinitionEntityToContract } from "@/pipeline-definitions/step-definition/application/step-definition-contract-mapper";
import {
  StepDefinitionEntity,
  type CreateStepDefinitionEntityProps,
} from "@/pipeline-definitions/step-definition/domain/step-definition-entity";
import type { TaskExecutionConfigContentInput } from "@/tasks/task-execution-config/contracts/task-execution-config-contracts";
import { TaskExecutionConfigEntity } from "@/tasks/task-execution-config/domain/task-execution-config-entity";
import { concurrentTest } from "tests/utils";

function baseProps(
  projectId: UuidV7 = createUuidV7(),
): CreateStepDefinitionEntityProps {
  return {
    projectId,
    key: "demo-step",
    name: "Demo Step",
    prompt: "Do the thing",
    version: 1,
    kind: "user_defined",
    inputSchemaJson: { type: "object" },
    resultSchemaJson: { type: "object" },
    taskExecutionConfigId: createUuidV7(),
    status: "active",
  };
}

const emptyContent: TaskExecutionConfigContentInput = {
  environment: null,
  git: null,
  mcp: null,
  healthChecks: null,
};

const contractFor = (content?: Partial<TaskExecutionConfigContentInput>) => {
  const projectId = createUuidV7();
  const config = content
    ? TaskExecutionConfigEntity.create({
        projectId,
        content: { ...emptyContent, ...content },
      })
    : null;
  const stepDefinition = StepDefinitionEntity.create({
    ...baseProps(projectId),
    taskExecutionConfigId: config?.id ?? null,
  });
  return stepDefinitionEntityToContract(stepDefinition, config);
};

describe("step definition entity taskExecutionConfigId", () => {
  concurrentTest(
    "round-trips through toJSON → rehydrate and survives archive",
    () => {
      const entity = StepDefinitionEntity.create(baseProps());

      const rehydrated = StepDefinitionEntity.rehydrate(entity.toJSON());
      const archived = entity.archive(new Date("2026-04-26T12:00:00.000Z"));

      expect(rehydrated.taskExecutionConfigId).toBe(
        entity.taskExecutionConfigId,
      );
      expect(archived.taskExecutionConfigId).toBe(entity.taskExecutionConfigId);
    },
  );

  concurrentTest("accepts a null config reference", () => {
    const entity = StepDefinitionEntity.create({
      ...baseProps(),
      taskExecutionConfigId: null,
    });

    expect(
      StepDefinitionEntity.rehydrate(entity.toJSON()).taskExecutionConfigId,
    ).toBeNull();
  });
});

describe("step definition entity concurrency", () => {
  concurrentTest("defaults to null and round-trips through toJSON", () => {
    expect(StepDefinitionEntity.create(baseProps()).concurrency).toBeNull();

    const entity = StepDefinitionEntity.create({
      ...baseProps(),
      concurrency: { max: 1, waiting: 1 },
    });
    expect(StepDefinitionEntity.rehydrate(entity.toJSON()).concurrency).toEqual(
      { max: 1, waiting: 1 },
    );
    expect(contractFor().concurrency).toBeNull();
  });

  concurrentTest.each([
    [{ max: 0, waiting: 0 }, "STEP_DEFINITION_CONCURRENCY_MAX_INVALID"],
    [{ max: 1.5, waiting: 0 }, "STEP_DEFINITION_CONCURRENCY_MAX_INVALID"],
    [{ max: 1, waiting: -1 }, "STEP_DEFINITION_CONCURRENCY_WAITING_INVALID"],
    [{ max: 1, waiting: 0.5 }, "STEP_DEFINITION_CONCURRENCY_WAITING_INVALID"],
  ])("refuses concurrency %p", (concurrency, code) => {
    expect(() =>
      StepDefinitionEntity.create({ ...baseProps(), concurrency }),
    ).toThrow(expect.objectContaining({ code }));
  });
});

describe("step definition entity logArchive", () => {
  const codeProps = (): CreateStepDefinitionEntityProps => ({
    ...baseProps(),
    kind: "code",
    prompt: null,
    entrypointJson: { sourceFile: ".scarn/steps.ts" },
  });

  concurrentTest("defaults to always and round-trips through toJSON", () => {
    expect(StepDefinitionEntity.create(baseProps()).logArchive).toBe("always");
    expect(contractFor().logs).toEqual({ archive: "always" });

    const entity = StepDefinitionEntity.create({
      ...codeProps(),
      logArchive: "on-failure",
    });
    expect(StepDefinitionEntity.rehydrate(entity.toJSON()).logArchive).toBe(
      "on-failure",
    );
  });

  concurrentTest("refuses on-failure on a step that isn't code", () => {
    expect(() =>
      StepDefinitionEntity.create({ ...baseProps(), logArchive: "on-failure" }),
    ).toThrow(
      expect.objectContaining({
        code: "STEP_DEFINITION_LOG_ARCHIVE_NOT_ALLOWED",
      }),
    );
  });
});

describe("step definition entity write rules", () => {
  concurrentTest("rehydrate trusts stored props the write rules refuse", () => {
    const stored = {
      ...StepDefinitionEntity.create(baseProps()).toJSON(),
      errors: ["Dup", "Dup"],
      retry: [{ on: ["Never.Declared"], maxAttempts: 0 }],
      concurrency: { max: 0, waiting: -1 },
    };

    const entity = StepDefinitionEntity.rehydrate(stored);

    expect(entity.errors).toEqual(["Dup", "Dup"]);
    expect(entity.retry).toEqual([{ on: ["Never.Declared"], maxAttempts: 0 }]);
    expect(entity.concurrency).toEqual({ max: 0, waiting: -1 });
  });

  concurrentTest(
    "update applies the write rules and keeps id and createdAt",
    () => {
      const createdAt = new Date("2026-04-26T12:00:00.000Z");
      const entity = StepDefinitionEntity.create({ ...baseProps(), createdAt });
      const props = {
        ...entity.toJSON(),
        id: createUuidV7(),
        createdAt: new Date("2030-01-01T00:00:00.000Z"),
      };

      const updated = entity.update({ ...props, name: "  Renamed  " });

      expect(updated.id).toBe(entity.id);
      expect(updated.createdAt).toEqual(createdAt);
      expect(updated.name).toBe("Renamed");
      expect(() =>
        entity.update({ ...props, concurrency: { max: 0, waiting: 0 } }),
      ).toThrow(
        expect.objectContaining({
          code: "STEP_DEFINITION_CONCURRENCY_MAX_INVALID",
        }),
      );
    },
  );
});

describe("step definition contract mapper", () => {
  concurrentTest("a null config reads back as the defaults", () => {
    const contract = contractFor();

    expect(contract.environment).toBeNull();
    expect(contract.repo).toEqual({
      mode: "readWrite",
      message: null,
      onPushFailure: "fail",
      gitCredentials: "auto",
      baseBranch: null,
      workBranch: { kind: "create" },
    });
    expect(contract.opencodeMcpJson).toBeNull();
    expect(contract.healthChecksJson).toBeNull();
  });

  concurrentTest(
    "reads the environment runtime without changing repo defaults",
    () => {
      const contract = contractFor({
        environment: { kind: "inline", runtime: { kind: "host" } },
      });

      expect(contract.environment).toEqual({
        kind: "inline",
        runtime: { kind: "host" },
      });
      expect(contract.repo).toEqual({
        mode: "readWrite",
        message: null,
        onPushFailure: "fail",
        gitCredentials: "auto",
        baseBranch: null,
        workBranch: { kind: "create" },
      });
    },
  );

  concurrentTest(
    "reads nested vars and runtime details from the config",
    () => {
      const envJson = [
        {
          name: "ACCOUNT_ID",
          source: "value" as const,
          value: "{{input.accountId}}",
          secret: false,
        },
      ];

      const withDevcontainer = contractFor({
        environment: {
          kind: "inline",
          runtime: {
            kind: "devcontainer",
            config: ".devcontainer/alt/devcontainer.json",
          },
          vars: envJson,
        },
      });
      const withManagedRuntime = contractFor({
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "bun1" },
        },
      });

      expect(withDevcontainer.environment).toMatchObject({
        kind: "inline",
        envJson,
        runtime: {
          kind: "devcontainer",
          config: ".devcontainer/alt/devcontainer.json",
        },
      });
      expect(withManagedRuntime.environment).toEqual({
        kind: "inline",
        runtime: { kind: "managed", id: "bun1" },
      });
    },
  );

  concurrentTest("reads repo, MCP and health checks from the config", () => {
    const opencodeMcpJson = {
      github: { type: "remote" as const, url: "https://example.com/mcp" },
    };
    const healthChecksJson = [
      {
        kind: "cli" as const,
        command: ["gh", "--version"],
        expectExitCode: 0,
        severity: "required" as const,
        timeoutSeconds: 15,
      },
      {
        kind: "tool" as const,
        tool: "list_issues",
        mcp: "github",
        severity: "required" as const,
        timeoutSeconds: 15,
      },
    ];

    const contract = contractFor({
      mcp: opencodeMcpJson,
      git: { mode: "readOnly" },
      healthChecks: healthChecksJson,
    });

    expect(contract.opencodeMcpJson).toEqual(opencodeMcpJson);
    expect(contract.repo).toEqual({
      mode: "readOnly",
      gitCredentials: "auto",
      baseBranch: null,
    });
    expect(contract.healthChecksJson).toEqual(healthChecksJson);
  });
});

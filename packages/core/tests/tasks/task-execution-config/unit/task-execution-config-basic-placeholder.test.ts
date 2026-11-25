import { describe, expect } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import type { CoreValidationError } from "@/lib/errors";
import type { TaskExecutionConfigContentInput } from "@/tasks/task-execution-config/contracts/task-execution-config-contracts";
import { TaskExecutionConfigEntity } from "@/tasks/task-execution-config/domain/task-execution-config-entity";
import { concurrentTest } from "tests/utils";

const create = (mcp: TaskExecutionConfigContentInput["mcp"]) =>
  TaskExecutionConfigEntity.create({
    projectId: createUuidV7(),
    content: { environment: null, git: null, mcp, healthChecks: null },
  });

describe("task execution config {basic:USER_VAR:PASS_VAR}", () => {
  concurrentTest("accepts it in a remote server header", () => {
    const config = create({
      jira: {
        type: "remote",
        url: "https://mcp.atlassian.com/v1/mcp",
        headers: { Authorization: "Basic {basic:JIRA_EMAIL:JIRA_API_TOKEN}" },
      },
    });

    expect(Object.keys(config.mcp ?? {})).toEqual(["jira"]);
  });

  concurrentTest("rejects it in a local server environment", () => {
    let code: string | null = null;
    try {
      create({
        db: {
          type: "local",
          command: ["db"],
          environment: { AUTH: "{basic:U:P}" },
        },
      });
    } catch (error) {
      code = (error as CoreValidationError).code;
    }
    expect(code).toBe("TASK_EXECUTION_CONFIG_INVALID");
  });
});

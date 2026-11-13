import { describe, expect, test } from "bun:test";
import { CliError } from "../src/lib/cli-error";
import {
  parseWorkItemRef,
  resolveWorkItemRef,
  type WorkItemRefPorts,
} from "../src/lib/resolve-work-item-ref";

const ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe001";
const PROJECT_ID = "project-1";

describe("parseWorkItemRef", () => {
  test.each([
    [ID, { kind: "id", value: ID }],
    [`  ${ID}  `, { kind: "id", value: ID }],
    [
      "https://github.com/acme/app/issues/12",
      { kind: "url", value: "https://github.com/acme/app/issues/12" },
    ],
    [
      "acme/app#123",
      { kind: "platformKey", platform: "github", value: "acme/app#123" },
    ],
    [
      "my-org/my.repo_2#7",
      { kind: "platformKey", platform: "github", value: "my-org/my.repo_2#7" },
    ],
    ["PROJ-42", { kind: "platformKey", platform: "jira", value: "PROJ-42" }],
  ])("%j parses", (input, expected) => {
    expect(parseWorkItemRef(input)).toEqual(expected as never);
  });

  test.each([
    "",
    "fix the login bug",
    "acme/app#",
    "acme#12",
    "proj-42",
    "https://",
    `${ID}\nmore`,
  ])("%j is not a reference", (input) => {
    expect(parseWorkItemRef(input)).toBeUndefined();
  });
});

function fakePorts(overrides: Partial<WorkItemRefPorts> = {}): {
  ports: WorkItemRefPorts;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    ports: {
      projectIdOfWorkItem: (id) => {
        calls.push(`id:${id}`);
        return Promise.resolve(PROJECT_ID);
      },
      currentProjectId: () => {
        calls.push("project");
        return Promise.resolve(PROJECT_ID);
      },
      findIdByUrl: (_projectId, url) => {
        calls.push(`url:${url}`);
        return Promise.resolve("from-url");
      },
      findIdByPlatformKey: (_projectId, platform, key) => {
        calls.push(`key:${platform}:${key}`);
        return Promise.resolve("from-key");
      },
      ...overrides,
    },
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof CliError ? error.code : "not-a-cli-error";
  }
  return "resolved";
}

describe("resolveWorkItemRef", () => {
  test("a UUID resolves to its own project without consulting --project", async () => {
    const { ports, calls } = fakePorts();
    expect(await resolveWorkItemRef(ID, ports)).toEqual({
      workItemId: ID,
      projectId: PROJECT_ID,
    });
    expect(calls).toEqual([`id:${ID}`]);
  });

  test("a URL is looked up in the current project", async () => {
    const { ports, calls } = fakePorts();
    const url = "https://linear.app/acme/issue/ACM-1";
    expect(await resolveWorkItemRef(url, ports)).toEqual({
      workItemId: "from-url",
      projectId: PROJECT_ID,
    });
    expect(calls).toEqual(["project", `url:${url}`]);
  });

  test("a platform key is looked up by platform and key", async () => {
    const { ports, calls } = fakePorts();
    expect(await resolveWorkItemRef("acme/app#9", ports)).toEqual({
      workItemId: "from-key",
      projectId: PROJECT_ID,
    });
    expect(calls).toEqual(["project", "key:github:acme/app#9"]);
  });

  test("unparseable input is invalid_usage", async () => {
    const { ports, calls } = fakePorts();
    expect(await codeOf(resolveWorkItemRef("not a ref", ports))).toBe(
      "invalid_usage",
    );
    expect(calls).toEqual([]);
  });

  test.each([
    [ID, { projectIdOfWorkItem: () => Promise.resolve(undefined) }],
    [
      "https://example.com/t/1",
      { findIdByUrl: () => Promise.resolve(undefined) },
    ],
    ["acme/app#1", { findIdByPlatformKey: () => Promise.resolve(undefined) }],
  ] as const)("%j with no match is no_work_item", async (input, override) => {
    const { ports } = fakePorts(override);
    expect(await codeOf(resolveWorkItemRef(input, ports))).toBe("no_work_item");
  });
});

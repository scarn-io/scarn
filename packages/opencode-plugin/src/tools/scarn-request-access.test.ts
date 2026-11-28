import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { GRANT_REQUEST_RELATIVE_PATH } from "@scarn/sdk/contracts/grant-request";
import {
  NO_TURNS_LEFT_MESSAGE,
  REQUEST_RECORDED_MESSAGE,
  createScarnRequestAccessTool,
  requestAccess,
  requestAccessDescription,
} from "./scarn-request-access";
import {
  grant,
  workItemTestWorkspace,
} from "./_shared/work-item-test-workspace";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readRequest(workspacePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(workspacePath, GRANT_REQUEST_RELATIVE_PATH),
      "utf8",
    ),
  );
}

const workspace = (overrides: Record<string, unknown> = {}) =>
  workItemTestWorkspace({
    grants: [grant("read", "self")],
    grantRequests: true,
    ...overrides,
  });

describe("requestAccess", () => {
  test.concurrent(
    "writes the request in the yield's shape and tells the agent to end its turn",
    async () => {
      const workspacePath = await workspace();

      const result = await requestAccess(workspacePath, {
        reason: "  I need to label the item as a bug.  ",
        grants: [{ action: "label", scope: "self", labels: ["bug"] }],
      });

      expect(result).toBe(REQUEST_RECORDED_MESSAGE);
      expect(await readRequest(workspacePath)).toEqual({
        reason: "I need to label the item as a bug.",
        grants: [
          {
            resource: "workItem",
            action: "label",
            scope: "self",
            labels: ["bug"],
          },
        ],
      });
    },
  );

  test.concurrent("a second call replaces the first request", async () => {
    const workspacePath = await workspace();

    await requestAccess(workspacePath, {
      reason: "First.",
      grants: [{ action: "comment", scope: "self" }],
    });
    await requestAccess(workspacePath, {
      reason: "Second.",
      grants: [{ action: "close", scope: "self" }],
    });

    expect(await readRequest(workspacePath)).toEqual({
      reason: "Second.",
      grants: [{ resource: "workItem", action: "close", scope: "self" }],
    });
  });

  const REFUSED_CASES: {
    name: string;
    input: { reason?: unknown; grants?: unknown };
    message: RegExp;
  }[] = [
    {
      name: "no grants",
      input: { reason: "Why.", grants: [] },
      message: /at least one grant/,
    },
    {
      name: "a missing reason",
      input: { reason: " ", grants: [{ action: "close", scope: "self" }] },
      message: /`reason`/,
    },
    {
      name: "an unknown action",
      input: { reason: "Why.", grants: [{ action: "delete", scope: "self" }] },
      message: /grants\[0\]/,
    },
    {
      name: "a label grant without labels",
      input: { reason: "Why.", grants: [{ action: "label", scope: "self" }] },
      message: /grants\[0\]/,
    },
    {
      name: "comment on project",
      input: {
        reason: "Why.",
        grants: [{ action: "comment", scope: "project" }],
      },
      message: /grants\[0\]/,
    },
    {
      name: "update on project, which only code steps hold",
      input: {
        reason: "Why.",
        grants: [{ action: "update", scope: "project" }],
      },
      message: /code steps only/,
    },
    {
      name: "a grant the Task already holds",
      input: { reason: "Why.", grants: [{ action: "read", scope: "self" }] },
      message: /already hold/,
    },
  ];

  for (const { name, input, message } of REFUSED_CASES) {
    test.concurrent(`refuses ${name} without writing`, async () => {
      const workspacePath = await workspace();

      expect(await requestAccess(workspacePath, input)).toMatch(message);
      expect(
        await exists(path.join(workspacePath, GRANT_REQUEST_RELATIVE_PATH)),
      ).toBe(false);
    });
  }

  test.concurrent(
    "keeps labels the Task doesn't hold yet on a held grant",
    async () => {
      const workspacePath = await workspace({
        grants: [grant("label", "self", ["bug"])],
      });

      expect(
        await requestAccess(workspacePath, {
          reason: "Why.",
          grants: [{ action: "label", scope: "self", labels: ["bug", "ui"] }],
        }),
      ).toBe(REQUEST_RECORDED_MESSAGE);
      expect(
        await requestAccess(workspacePath, {
          reason: "Why.",
          grants: [{ action: "label", scope: "self", labels: ["bug"] }],
        }),
      ).toMatch(/already hold/);
    },
  );

  test.concurrent("refuses when no turns are left", async () => {
    const workspacePath = await workspace({ turnsRemaining: 0 });

    expect(
      await requestAccess(workspacePath, {
        reason: "Why.",
        grants: [{ action: "close", scope: "self" }],
      }),
    ).toBe(NO_TURNS_LEFT_MESSAGE);
    expect(
      await exists(path.join(workspacePath, GRANT_REQUEST_RELATIVE_PATH)),
    ).toBe(false);
  });
});

describe("requestAccessDescription", () => {
  test("lists what may be asked for and what is held", () => {
    const description = requestAccessDescription([grant("read", "self")]);

    expect(description).toContain(
      "- `close` on `children`: Close its child work items.",
    );
    expect(description).toContain("- `create` on `project`:");
    expect(description).not.toContain("`update` on `project`");
    expect(description).toContain("You already hold:\n- Read your work item.");
  });

  test("is the tool's description", () => {
    const tool = createScarnRequestAccessTool("/workspace", []);

    expect(tool.description).toBe(requestAccessDescription([]));
    expect(tool.description).toContain("You already hold:\n- Nothing.");
  });
});

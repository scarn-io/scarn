import { describe, expect, test } from "bun:test";
import {
  bodyOf,
  created,
  fakeFetch,
  UUID_V7,
} from "./_shared/create-work-item-test-fetch";
import {
  grant,
  workItemTestWorkspace,
} from "./_shared/work-item-test-workspace";
import {
  CREATED_WORK_ITEM_NOTE,
  createWorkItem,
  EXISTING_WORK_ITEM_NOTE,
  NO_PROJECT_CREATE_MESSAGE,
  PLATFORM_KEY_REQUIRED_MESSAGE,
} from "./scarn-create-work-item";

/**
 * The create tool's project form: given a `platformKey`, a top-level item in
 * the project, as a scheduled Task with a `create` grant on `project` makes.
 */
describe("createWorkItem in the project", () => {
  const scheduled = () =>
    workItemTestWorkspace({
      workItemId: null,
      grants: [grant("create", "project")],
    });

  test.concurrent(
    "a run with no work item posts a project create with its platformKey and url",
    async () => {
      const workspacePath = await scheduled();
      const { fetch, calls } = fakeFetch(created("server-id"));

      const output = JSON.parse(
        await createWorkItem(
          {
            platformKey: "TICKET-1",
            url: "https://tickets.example.com/1",
            title: "Ticket",
            description: "Found",
            labels: ["bug"],
          },
          workspacePath,
          fetch,
        ),
      ) as { workItemId: string; note: string };

      const { workItemId, ...body } = bodyOf(calls[0]);
      expect(workItemId).toMatch(UUID_V7);
      expect(body).toEqual({
        claimToken: "claim-1",
        scope: "project",
        platformKey: "TICKET-1",
        url: "https://tickets.example.com/1",
        title: "Ticket",
        description: "Found",
        labels: ["bug"],
      });
      expect(output.workItemId).toBe("server-id");
      expect(output.note).toBe(CREATED_WORK_ITEM_NOTE);
    },
  );

  test.concurrent(
    "a key the project already has returns that item's id with a note",
    async () => {
      const workspacePath = await scheduled();
      const { fetch } = fakeFetch(created("existing-id", false));

      const output = JSON.parse(
        await createWorkItem(
          { platformKey: "TICKET-1", title: "Ticket", description: "" },
          workspacePath,
          fetch,
        ),
      ) as { workItemId: string; note: string };

      expect(output).toMatchObject({
        workItemId: "existing-id",
        note: EXISTING_WORK_ITEM_NOTE,
      });
    },
  );

  test.concurrent("refuses without a platformKey", async () => {
    const workspacePath = await scheduled();
    const { fetch, calls } = fakeFetch(created());

    expect(
      await createWorkItem(
        { title: "Ticket", description: "" },
        workspacePath,
        fetch,
      ),
    ).toBe(PLATFORM_KEY_REQUIRED_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  test.concurrent(
    "refuses a platformKey without a create grant on project",
    async () => {
      const workspacePath = await workItemTestWorkspace();
      const { fetch, calls } = fakeFetch(created());

      expect(
        await createWorkItem(
          { platformKey: "TICKET-1", title: "Ticket", description: "" },
          workspacePath,
          fetch,
        ),
      ).toBe(NO_PROJECT_CREATE_MESSAGE);
      expect(calls).toHaveLength(0);
    },
  );

  test.concurrent("refuses blockedBy with a platformKey", async () => {
    const workspacePath = await scheduled();
    const { fetch, calls } = fakeFetch(created());

    expect(
      await createWorkItem(
        {
          platformKey: "TICKET-1",
          title: "Ticket",
          description: "",
          blockedBy: ["item-other"],
        },
        workspacePath,
        fetch,
      ),
    ).toContain("`blockedBy` can't be given with `platformKey`");
    expect(calls).toHaveLength(0);
  });

  test.concurrent("refuses a url without a platformKey", async () => {
    const workspacePath = await workItemTestWorkspace();
    const { fetch, calls } = fakeFetch(created());

    expect(
      await createWorkItem(
        { url: "https://x.test", title: "Child", description: "" },
        workspacePath,
        fetch,
      ),
    ).toContain("given only with `platformKey`");
    expect(calls).toHaveLength(0);
  });
});

import { describe, expect, test } from "bun:test";
import { readWorkItemChanges } from "@scarn/sdk/contracts/work-item-changes";
import { workItemTestWorkspace } from "./_shared/work-item-test-workspace";
import {
  invalidInputMessage,
  missingPermissionMessage,
  NO_WORK_ITEM_MESSAGE,
} from "./_shared/work-item-tool-support";
import { getWorkItem, NO_API_MESSAGE } from "./scarn-get-work-item";

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(response: Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("getWorkItem", () => {
  test.concurrent(
    "posts the claim token and item id to the run's work-item-reads route",
    async () => {
      const workspacePath = await workItemTestWorkspace();
      const { fetch, calls } = fakeFetch(
        new Response(JSON.stringify({ id: "item-self", title: "T" })),
      );

      const output = await getWorkItem(
        { workItemId: "item-self" },
        workspacePath,
        fetch,
      );

      expect(JSON.parse(output)).toEqual({
        id: "item-self",
        title: "T",
        url: null,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        "http://api.test/api/task-runs/task-run-1/work-item-reads",
      );
      expect(calls[0]?.init?.method).toBe("POST");
      expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
        claimToken: "claim-1",
        workItemId: "item-self",
      });
      expect(await readWorkItemChanges(workspacePath)).toEqual([]);
    },
  );

  test.concurrent(
    "reads the run's own work item when no id is given",
    async () => {
      const workspacePath = await workItemTestWorkspace();
      const { fetch, calls } = fakeFetch(
        new Response(JSON.stringify({ id: "item-self", title: "T" })),
      );

      await getWorkItem({}, workspacePath, fetch);

      expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
        claimToken: "claim-1",
        workItemId: "item-self",
      });
    },
  );

  test.concurrent("refuses an empty id", async () => {
    const workspacePath = await workItemTestWorkspace();
    const { fetch, calls } = fakeFetch(new Response("{}"));

    expect(await getWorkItem({ workItemId: " " }, workspacePath, fetch)).toBe(
      invalidInputMessage(
        "`workItemId` must be a non-empty string, or left out to read your own work item.",
      ),
    );
    expect(calls).toHaveLength(0);
  });

  test.concurrent(
    "adds the web page url to the item, its blockers and its children",
    async () => {
      const workspacePath = await workItemTestWorkspace({
        workItemLinks: {
          appBaseUrl: "https://app.test",
          projectPath: "acme/web",
        },
      });
      const { fetch } = fakeFetch(
        new Response(
          JSON.stringify({
            id: "item-self",
            title: "T",
            blockers: [{ id: "item-b", title: "B" }],
            children: [{ id: "item-c", title: "C" }],
          }),
        ),
      );

      const output = JSON.parse(
        await getWorkItem({ workItemId: "item-self" }, workspacePath, fetch),
      ) as unknown;

      const page = (id: string): string =>
        `https://app.test/acme/web/work-items/${id}`;
      expect(output).toEqual({
        id: "item-self",
        title: "T",
        url: page("item-self"),
        blockers: [{ id: "item-b", title: "B", url: page("item-b") }],
        children: [{ id: "item-c", title: "C", url: page("item-c") }],
      });
    },
  );

  test.concurrent("reports a failed read with its status", async () => {
    const workspacePath = await workItemTestWorkspace();
    const { fetch } = fakeFetch(new Response("not found", { status: 404 }));

    expect(
      await getWorkItem({ workItemId: "item-x" }, workspacePath, fetch),
    ).toBe("Reading the work item failed (HTTP 404): not found");
  });

  test.concurrent("refuses without API access", async () => {
    const workspacePath = await workItemTestWorkspace({ api: null });
    const { fetch, calls } = fakeFetch(new Response("{}"));

    expect(
      await getWorkItem({ workItemId: "item-self" }, workspacePath, fetch),
    ).toBe(NO_API_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  test.concurrent("refuses without the self permission", async () => {
    const workspacePath = await workItemTestWorkspace({
      workItemPermissions: [],
    });
    const { fetch } = fakeFetch(new Response("{}"));

    expect(
      await getWorkItem({ workItemId: "item-self" }, workspacePath, fetch),
    ).toBe(missingPermissionMessage("self"));
  });

  test.concurrent("refuses outside a run on a work item", async () => {
    const workspacePath = await workItemTestWorkspace({ workItemId: null });
    const { fetch } = fakeFetch(new Response("{}"));

    expect(
      await getWorkItem({ workItemId: "item-self" }, workspacePath, fetch),
    ).toBe(NO_WORK_ITEM_MESSAGE);
  });
});

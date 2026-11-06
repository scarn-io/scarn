import { describe, expect, test } from "bun:test";
import { readWorkItemChanges } from "@scarn/sdk/contracts/work-item-changes";
import {
  grant,
  workItemTestWorkspace,
} from "./_shared/work-item-test-workspace";
import {
  missingGrantMessage,
  NO_WORK_ITEM_MESSAGE,
} from "./_shared/work-item-tool-support";
import {
  CREATED_WORK_ITEM_NOTE,
  createWorkItem,
  NO_API_MESSAGE,
} from "./scarn-create-work-item";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(...outcomes: (Response | Error)[]): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    const outcome = outcomes[Math.min(calls.length, outcomes.length - 1)];
    calls.push({ url, init });
    return outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome?.clone());
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function created(workItemId = "ignored"): Response {
  return new Response(JSON.stringify({ workItemId, created: true }), {
    status: 201,
  });
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(call?.init?.body as string) as Record<string, unknown>;
}

describe("createWorkItem", () => {
  test.concurrent(
    "posts the item with a generated UUIDv7 to the run's work-item-creates route",
    async () => {
      const workspacePath = await workItemTestWorkspace();
      const { fetch, calls } = fakeFetch(created());

      const output = JSON.parse(
        await createWorkItem(
          {
            title: "Child",
            description: "Do it",
            fields: { size: "s" },
            labels: ["bug"],
            blockedBy: ["item-other"],
          },
          workspacePath,
          fetch,
        ),
      ) as { workItemId: string };

      expect(output.workItemId).toMatch(UUID_V7);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        "http://api.test/api/task-runs/task-run-1/work-item-creates",
      );
      expect(calls[0]?.init?.method).toBe("POST");
      expect(bodyOf(calls[0])).toEqual({
        claimToken: "claim-1",
        workItemId: output.workItemId,
        title: "Child",
        description: "Do it",
        fields: { size: "s" },
        labels: ["bug"],
        blockedBy: ["item-other"],
      });
      expect(await readWorkItemChanges(workspacePath)).toEqual([]);
    },
  );

  test.concurrent("omits absent optional fields", async () => {
    const workspacePath = await workItemTestWorkspace();
    const { fetch, calls } = fakeFetch(created());

    await createWorkItem(
      { title: "Child", description: "", labels: [] },
      workspacePath,
      fetch,
    );

    expect(Object.keys(bodyOf(calls[0])).sort()).toEqual([
      "claimToken",
      "description",
      "title",
      "workItemId",
    ]);
  });

  test.concurrent(
    "returns the new item's web page url and a note on linking it",
    async () => {
      const workspacePath = await workItemTestWorkspace({
        workItemLinks: {
          appBaseUrl: "https://app.test/",
          projectPath: "acme/web",
        },
      });
      const { fetch } = fakeFetch(created());

      const output = JSON.parse(
        await createWorkItem(
          { title: "Child", description: "" },
          workspacePath,
          fetch,
        ),
      ) as { workItemId: string; url: string; note: string };

      expect(output.url).toBe(
        `https://app.test/acme/web/work-items/${output.workItemId}`,
      );
      expect(output.note).toBe(CREATED_WORK_ITEM_NOTE);
      expect(output.note).toContain("[title](url)");
    },
  );

  test.concurrent("returns a null url without work item links", async () => {
    const workspacePath = await workItemTestWorkspace();
    const { fetch } = fakeFetch(created());

    const output = JSON.parse(
      await createWorkItem(
        { title: "Child", description: "" },
        workspacePath,
        fetch,
      ),
    ) as { url: unknown };

    expect(output.url).toBeNull();
  });

  test.concurrent("treats a replayed create as created", async () => {
    const workspacePath = await workItemTestWorkspace();
    const { fetch } = fakeFetch(
      new Response(JSON.stringify({ workItemId: "x", created: false }), {
        status: 200,
      }),
    );

    const output = JSON.parse(
      await createWorkItem(
        { title: "Child", description: "" },
        workspacePath,
        fetch,
      ),
    ) as { note: string };

    expect(output.note).toBe(CREATED_WORK_ITEM_NOTE);
  });

  test.concurrent("retries a network error once with the same id", async () => {
    const workspacePath = await workItemTestWorkspace();
    const { fetch, calls } = fakeFetch(new Error("socket hang up"), created());

    const output = JSON.parse(
      await createWorkItem(
        { title: "Child", description: "" },
        workspacePath,
        fetch,
      ),
    ) as { workItemId: string };

    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[0])["workItemId"]).toBe(output.workItemId);
    expect(bodyOf(calls[1])).toEqual(bodyOf(calls[0]));
  });

  test.concurrent("retries a 5xx once with the same id", async () => {
    const workspacePath = await workItemTestWorkspace();
    const { fetch, calls } = fakeFetch(
      new Response("bad gateway", { status: 502 }),
      created(),
    );

    const output = JSON.parse(
      await createWorkItem(
        { title: "Child", description: "" },
        workspacePath,
        fetch,
      ),
    ) as { workItemId: string };

    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[1])["workItemId"]).toBe(output.workItemId);
  });

  test.concurrent("gives up after the one retry", async () => {
    const workspacePath = await workItemTestWorkspace();
    const { fetch, calls } = fakeFetch(new Error("socket hang up"));

    expect(
      await createWorkItem(
        { title: "Child", description: "" },
        workspacePath,
        fetch,
      ),
    ).toBe("Creating the work item failed: socket hang up");
    expect(calls).toHaveLength(2);
  });

  test.concurrent(
    "shows a server refusal as written, without retrying",
    async () => {
      const workspacePath = await workItemTestWorkspace();
      const refusal =
        "This Task has already created 10 work items, the most one Task may create.";
      const { fetch, calls } = fakeFetch(
        new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Conflict",
            status: 409,
            detail: refusal,
          }),
          { status: 409 },
        ),
      );

      expect(
        await createWorkItem(
          { title: "Child", description: "" },
          workspacePath,
          fetch,
        ),
      ).toBe(refusal);
      expect(calls).toHaveLength(1);
    },
  );

  test.concurrent(
    "shows the status and body of a refusal without a message",
    async () => {
      const workspacePath = await workItemTestWorkspace();
      const { fetch } = fakeFetch(new Response("nope", { status: 400 }));

      expect(
        await createWorkItem(
          { title: "Child", description: "" },
          workspacePath,
          fetch,
        ),
      ).toBe("Creating the work item failed (HTTP 400): nope");
    },
  );

  test.concurrent("refuses without API access", async () => {
    const workspacePath = await workItemTestWorkspace({ api: null });
    const { fetch, calls } = fakeFetch(created());

    expect(
      await createWorkItem(
        { title: "Child", description: "" },
        workspacePath,
        fetch,
      ),
    ).toBe(NO_API_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  test.concurrent("refuses without a create grant", async () => {
    const workspacePath = await workItemTestWorkspace({
      grants: [grant("read", "self"), grant("update", "children")],
    });
    const { fetch, calls } = fakeFetch(created());

    expect(
      await createWorkItem(
        { title: "Child", description: "" },
        workspacePath,
        fetch,
      ),
    ).toBe(missingGrantMessage("create"));
    expect(calls).toHaveLength(0);
  });

  test.concurrent("refuses outside a run on a work item", async () => {
    const workspacePath = await workItemTestWorkspace({ workItemId: null });
    const { fetch } = fakeFetch(created());

    expect(
      await createWorkItem(
        { title: "Child", description: "" },
        workspacePath,
        fetch,
      ),
    ).toBe(NO_WORK_ITEM_MESSAGE);
  });

  test.concurrent("rejects an empty title without posting", async () => {
    const workspacePath = await workItemTestWorkspace();
    const { fetch, calls } = fakeFetch(created());

    expect(
      await createWorkItem(
        { title: " ", description: "" },
        workspacePath,
        fetch,
      ),
    ).toContain("Invalid input");
    expect(calls).toHaveLength(0);
  });

  test.concurrent("rejects labels that are not strings", async () => {
    const workspacePath = await workItemTestWorkspace();
    const { fetch, calls } = fakeFetch(created());

    expect(
      await createWorkItem(
        { title: "Child", description: "", labels: ["bug", 3] },
        workspacePath,
        fetch,
      ),
    ).toContain("`labels`");
    expect(calls).toHaveLength(0);
  });
});

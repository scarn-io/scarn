import { beforeAll, describe, expect } from "bun:test";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  createAutomationFixture,
  createMember,
  createWorkItem,
  projectAutomationDocument,
  publishAutomationRequest,
  workItemAutomationDocument,
  type AutomationFixture,
  type AuthHeaders,
} from "./automation-test-support";

describe("attaching and enabling automations", () => {
  let fixture: AutomationFixture;
  let workKey: string;
  let projectKey: string;

  beforeAll(async () => {
    fixture = await createAutomationFixture("attach");
    workKey = `wayfinder-${crypto.randomUUID()}`;
    projectKey = `triage-${crypto.randomUUID()}`;
    await unwrapAsync(
      publishAutomationRequest(
        fixture,
        workItemAutomationDocument(workKey, [
          {
            key: "self-attached",
            event: "self.attached",
            next: {
              routes: [
                { kind: "step", to: fixture.planStepKey, on: "workItem" },
              ],
            },
          },
        ]),
        fixture.headers,
      ),
    );
    await unwrapAsync(
      publishAutomationRequest(
        fixture,
        projectAutomationDocument(projectKey, [
          {
            key: "work-item-created",
            event: "workItem.created",
            next: { routes: [{ kind: "attach", automation: workKey }] },
          },
        ]),
        fixture.headers,
      ),
    );
  });

  const automationsOf = (workItemId: string) =>
    fixture.apiClient.api["work-items"]({ workItemId }).automations;

  const attach = (workItemId: string, key: string, headers: AuthHeaders) =>
    automationsOf(workItemId)({ key }).post(undefined, {
      headers: { ...headers },
    });

  const detach = (workItemId: string, key: string, headers: AuthHeaders) =>
    automationsOf(workItemId)({ key }).delete(undefined, {
      headers: { ...headers },
    });

  const list = async (workItemId: string) =>
    await unwrapAsync(
      automationsOf(workItemId).get({ headers: { ...fixture.headers } }),
    );

  const toggle = (
    key: string,
    action: "enable" | "disable",
    headers: AuthHeaders,
  ) =>
    fixture.apiClient.api
      .projects({ projectId: fixture.projectId })
      .automations({ key })
      [action].post(undefined, { headers: { ...headers } });

  concurrentTest("attaches idempotently, lists and detaches", async () => {
    const workItem = await createWorkItem(fixture, fixture.headers);
    const attached = await unwrapAsync(
      attach(workItem.id, workKey, fixture.headers),
    );
    expect(attached).toMatchObject({
      workItemId: workItem.id,
      attachedByUserId: fixture.ownerUserId,
      automation: { key: workKey, latestVersion: { version: 1 } },
    });

    const again = await unwrapAsync(
      attach(workItem.id, workKey, fixture.headers),
    );
    expect(again.attachedAt).toBe(attached.attachedAt);
    expect(
      (await list(workItem.id)).map((entry) => entry.automation.key),
    ).toEqual([workKey]);

    expect(
      await unwrapAsync(detach(workItem.id, workKey, fixture.headers)),
    ).toEqual({ detached: true });
    expect(await list(workItem.id)).toEqual([]);

    const missing = await detach(workItem.id, workKey, fixture.headers);
    expect(missing.error?.status).toBe(404);
  });

  concurrentTest("an attachment follows the latest version", async () => {
    const key = `following-${crypto.randomUUID()}`;
    const document = (to: string) =>
      workItemAutomationDocument(key, [
        {
          key: "self-attached",
          event: "self.attached",
          next: { routes: [{ kind: "step", to, on: "workItem" }] },
        },
      ]);
    await unwrapAsync(
      publishAutomationRequest(
        fixture,
        document(fixture.planStepKey),
        fixture.headers,
      ),
    );
    const workItem = await createWorkItem(fixture, fixture.headers);
    await unwrapAsync(attach(workItem.id, key, fixture.headers));
    await unwrapAsync(
      publishAutomationRequest(
        fixture,
        {
          ...document(fixture.researchStepKey),
          rules: [
            {
              key: "self-attached",
              event: "self.attached",
              next: {
                routes: [
                  {
                    kind: "step",
                    to: fixture.researchStepKey,
                    args: { question: "event.workItem.title" },
                    on: "workItem",
                  },
                ],
              },
            },
          ],
        },
        fixture.headers,
      ),
    );
    const [entry] = await list(workItem.id);
    expect(entry?.automation.latestVersion?.version).toBe(2);
  });

  concurrentTest("rejects bad attaches", async () => {
    const workItem = await createWorkItem(fixture, fixture.headers);
    const unknown = await attach(workItem.id, "missing", fixture.headers);
    expect(unknown.error?.status).toBe(404);

    const projectScope = await attach(workItem.id, projectKey, fixture.headers);
    expect(projectScope.error?.status).toBe(400);
    expect(projectScope.error?.value).toMatchObject({
      code: "AUTOMATION_NOT_WORK_ITEM_SCOPE",
    });

    await unwrapAsync(
      fixture.apiClient.api["work-items"]({
        workItemId: workItem.id,
      }).state.put(
        { state: "closed", reason: "completed" },
        { headers: { ...fixture.headers } },
      ),
    );
    const closed = await attach(workItem.id, workKey, fixture.headers);
    expect(closed.error?.status).toBe(400);
    expect(closed.error?.value).toMatchObject({ code: "WORK_ITEM_CLOSED" });
  });

  concurrentTest("attach and detach need work-items:update", async () => {
    const workItem = await createWorkItem(fixture, fixture.headers);
    const reader = await createMember(fixture, "read");
    expect((await attach(workItem.id, workKey, reader)).error?.status).toBe(
      403,
    );
    await unwrapAsync(attach(workItem.id, workKey, fixture.headers));
    expect((await detach(workItem.id, workKey, reader)).error?.status).toBe(
      403,
    );
    const listed = await automationsOf(workItem.id).get({
      headers: { ...reader },
    });
    expect(listed.data?.length).toBe(1);
  });

  concurrentTest("enables and disables a project automation", async () => {
    const key = `inert-${crypto.randomUUID()}`;
    await unwrapAsync(
      publishAutomationRequest(
        fixture,
        projectAutomationDocument(key, [
          {
            key: "work-item-created",
            event: "workItem.created",
            next: { routes: [{ kind: "skip" }] },
          },
        ]),
        fixture.headers,
      ),
    );
    const enabled = await unwrapAsync(toggle(key, "enable", fixture.headers));
    expect(enabled).toMatchObject({ key, enabled: true });
    const again = await unwrapAsync(toggle(key, "enable", fixture.headers));
    expect(again.enabled).toBe(true);
    const disabled = await unwrapAsync(toggle(key, "disable", fixture.headers));
    expect(disabled.enabled).toBe(false);
  });

  concurrentTest(
    "enable rejects work-item and unknown automations",
    async () => {
      const workScope = await toggle(workKey, "enable", fixture.headers);
      expect(workScope.error?.status).toBe(400);
      expect(workScope.error?.value).toMatchObject({
        code: "AUTOMATION_NOT_PROJECT_SCOPE",
      });
      const unknown = await toggle("missing", "disable", fixture.headers);
      expect(unknown.error?.status).toBe(404);
    },
  );

  concurrentTest("enable needs executions:write", async () => {
    const reader = await createMember(fixture, "read");
    expect((await toggle(projectKey, "enable", reader)).error?.status).toBe(
      403,
    );
  });
});

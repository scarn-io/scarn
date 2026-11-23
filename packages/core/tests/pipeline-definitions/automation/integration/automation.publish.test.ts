import { beforeAll, describe, expect } from "bun:test";
import type { Grant } from "@/tasks/task/domain/grants";
import { concurrentTest, unwrapAsync } from "tests/utils";
import { grant } from "tests/tasks/task/grants-test-support";
import { buildAgentStepDefinitionPayload } from "../../pipeline-test-support";
import {
  createAutomationFixture,
  createMember,
  projectAutomationDocument,
  publishAutomationRequest,
  workItemAutomationDocument,
  type AutomationFixture,
} from "./automation-test-support";

type ErrorBody = { code?: string; meta?: { errors?: { path: string }[] } };

const errorPaths = (error: { value: object } | null | undefined): string[] =>
  ((error?.value as ErrorBody | undefined)?.meta?.errors ?? []).map(
    (entry) => entry.path,
  );

const missingFrom = (actual: string[], expected: string[]) =>
  expected.filter((item) => !actual.includes(item));

describe("publishing automations", () => {
  let fixture: AutomationFixture;

  beforeAll(async () => {
    fixture = await createAutomationFixture("publish");
  });

  const wayfinder = (key = `wayfinder-${crypto.randomUUID()}`) =>
    workItemAutomationDocument(key, [
      {
        key: "self-attached",
        event: "self.attached",
        next: {
          routes: [{ kind: "step", to: fixture.planStepKey, on: "workItem" }],
        },
      },
      {
        key: "child-ready",
        event: "child.ready",
        next: {
          routes: [
            {
              when: {
                path: "event.child.labels",
                op: "contains",
                value: "wayfinder:research",
              },
              kind: "step",
              to: fixture.researchStepKey,
              args: { question: "event.child.title" },
              on: "child",
            },
          ],
          otherwise: {
            kind: "pipeline",
            to: fixture.pipelineKey,
            on: "child",
          },
        },
      },
    ]);

  concurrentTest(
    "publishes version 1, then nothing for an unchanged document",
    async () => {
      const document = wayfinder();
      const first = await unwrapAsync(
        publishAutomationRequest(fixture, document, fixture.headers),
      );
      expect(first.published).toBe(true);
      expect(first.automation).toMatchObject({
        key: document["key"],
        title: document["title"],
        scope: "workItem",
        enabled: false,
        latestVersion: { version: 1, document },
      });

      const again = await unwrapAsync(
        publishAutomationRequest(fixture, document, fixture.headers),
      );
      expect(again.published).toBe(false);
      expect(again.automation.latestVersion?.id).toBe(
        first.automation.latestVersion?.id,
      );

      const changed = await unwrapAsync(
        publishAutomationRequest(
          fixture,
          { ...document, title: "Renamed" },
          fixture.headers,
        ),
      );
      expect(changed.published).toBe(true);
      expect(changed.automation.title).toBe("Renamed");
      expect(changed.automation.latestVersion?.version).toBe(2);
    },
  );

  concurrentTest("rejects routes that don't fit the catalog", async () => {
    const document = workItemAutomationDocument(
      `broken-${crypto.randomUUID()}`,
      [
        {
          key: "self-attached",
          event: "self.attached",
          next: {
            routes: [
              { kind: "step", to: "nope", on: "workItem" },
              { kind: "pipeline", to: "missing", on: "workItem" },
              {
                kind: "step",
                to: fixture.researchStepKey,
                args: { question: "event.child.title" },
                on: "workItem",
              },
            ],
          },
        },
        {
          key: "child-created",
          event: "child.created",
          next: {
            routes: [
              {
                kind: "step",
                to: fixture.researchStepKey,
                args: { question: "event.child.labels", extra: "x" },
                on: "child",
              },
            ],
          },
        },
      ],
    );
    const { data, error } = await publishAutomationRequest(
      fixture,
      document,
      fixture.headers,
    );
    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "AUTOMATION_DOCUMENT_INVALID" });
    expect(
      missingFrom(errorPaths(error), [
        "/rules/0/next/routes/0/to",
        "/rules/0/next/routes/1/to",
        "/rules/0/next/routes/2/args/question",
        "/rules/1/next/routes/0/args/question",
        "/rules/1/next/routes/0/args/extra",
      ]),
    ).toEqual([]);
  });

  concurrentTest("rejects `on: child` on an event without one", async () => {
    const { error } = await publishAutomationRequest(
      fixture,
      workItemAutomationDocument(`on-${crypto.randomUUID()}`, [
        {
          key: "self-attached",
          event: "self.attached",
          next: {
            routes: [{ kind: "step", to: fixture.planStepKey, on: "child" }],
          },
        },
      ]),
      fixture.headers,
    );
    expect(error?.status).toBe(422);
    expect(errorPaths(error)).toEqual(["/rules/0/next"]);
  });

  const skipRule = { next: { routes: [{ kind: "skip" }] } };

  concurrentTest("rejects a rule without a key", async () => {
    const { error } = await publishAutomationRequest(
      fixture,
      workItemAutomationDocument(`rule-keys-${crypto.randomUUID()}`, [
        { ...skipRule, key: "ready", event: "child.ready" },
        { ...skipRule, event: "child.created" },
      ]),
      fixture.headers,
    );
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "AUTOMATION_DOCUMENT_INVALID" });
    expect(errorPaths(error)).toEqual(["/rules/1/key"]);
  });

  concurrentTest("rejects two rules with the same key", async () => {
    const { error } = await publishAutomationRequest(
      fixture,
      workItemAutomationDocument(`rule-keys-${crypto.randomUUID()}`, [
        { ...skipRule, key: "same", event: "child.ready" },
        { ...skipRule, key: "same", event: "child.closed" },
      ]),
      fixture.headers,
    );
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "AUTOMATION_DOCUMENT_INVALID" });
    expect(errorPaths(error)).toEqual(["/rules/1/key"]);
  });

  concurrentTest("attach must name a work-item automation", async () => {
    const target = wayfinder();
    await unwrapAsync(
      publishAutomationRequest(fixture, target, fixture.headers),
    );
    const projectKey = `router-${crypto.randomUUID()}`;
    const router = (automation: string) =>
      projectAutomationDocument(projectKey, [
        {
          key: "work-item-label-added",
          event: "workItem.label.added",
          next: {
            routes: [
              {
                when: { path: "event.label", op: "equal", value: "wayfinder" },
                kind: "attach",
                automation,
              },
            ],
            otherwise: { kind: "skip" },
          },
        },
      ]);

    const unknown = await publishAutomationRequest(
      fixture,
      router("missing"),
      fixture.headers,
    );
    expect(errorPaths(unknown.error)).toEqual([
      "/rules/0/next/routes/0/automation",
    ]);
    const self = await publishAutomationRequest(
      fixture,
      router(projectKey),
      fixture.headers,
    );
    expect(errorPaths(self.error)).toEqual([
      "/rules/0/next/routes/0/automation",
    ]);

    const published = await unwrapAsync(
      publishAutomationRequest(
        fixture,
        router(target["key"] as string),
        fixture.headers,
      ),
    );
    expect(published.automation).toMatchObject({
      scope: "project",
      enabled: false,
      title: null,
    });
  });

  describe("a schedule rule's step", () => {
    const stepWith = async (grants: Grant[]) =>
      (
        await unwrapAsync(
          fixture.apiClient.api["step-definitions"].post(
            {
              ...buildAgentStepDefinitionPayload(fixture.projectId),
              grants,
            },
            { headers: { ...fixture.headers } },
          ),
        )
      ).key;

    const scheduleStarting = (stepKey: string) =>
      projectAutomationDocument(`poller-${crypto.randomUUID()}`, [
        {
          key: "poll",
          event: "schedule",
          cron: "*/15 * * * *",
          next: { routes: [{ kind: "step", to: stepKey }] },
        },
      ]);

    concurrentTest(
      "is rejected when it has grants on self or children",
      async () => {
        const stepKey = await stepWith([
          grant("create", "project", ["intake"]),
          grant("comment", "self"),
          grant("create", "children", ["intake"]),
        ]);

        const { error } = await publishAutomationRequest(
          fixture,
          scheduleStarting(stepKey),
          fixture.headers,
        );

        expect(error?.status).toBe(422);
        expect(error?.value).toMatchObject({
          code: "AUTOMATION_DOCUMENT_INVALID",
        });
        expect(errorPaths(error)).toEqual(["/rules/0/next/routes/0/to"]);
      },
    );

    concurrentTest("is accepted with only project grants", async () => {
      const stepKey = await stepWith([grant("create", "project", ["intake"])]);

      const published = await unwrapAsync(
        publishAutomationRequest(
          fixture,
          scheduleStarting(stepKey),
          fixture.headers,
        ),
      );

      expect(published.published).toBe(true);
    });
  });

  concurrentTest("the document key must match the route key", async () => {
    const { error } = await publishAutomationRequest(
      fixture,
      wayfinder(),
      fixture.headers,
      "another-key",
    );
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "AUTOMATION_DOCUMENT_KEY_MISMATCH",
    });
  });

  concurrentTest("a published automation can't change scope", async () => {
    const key = `scoped-${crypto.randomUUID()}`;
    await unwrapAsync(
      publishAutomationRequest(fixture, wayfinder(key), fixture.headers),
    );
    const { error } = await publishAutomationRequest(
      fixture,
      projectAutomationDocument(key, []),
      fixture.headers,
    );
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "AUTOMATION_SCOPE_CHANGED" });
  });

  concurrentTest(
    "lists automations in key order with their latest version",
    async () => {
      const keys = ["b", "a"].map(
        (prefix) => `${prefix}-list-${crypto.randomUUID()}`,
      );
      for (const key of keys) {
        await unwrapAsync(
          publishAutomationRequest(fixture, wayfinder(key), fixture.headers),
        );
      }
      const listed = await unwrapAsync(
        fixture.apiClient.api
          .projects({ projectId: fixture.projectId })
          .automations.get({ headers: { ...fixture.headers } }),
      );
      const listedKeys = listed.map((automation) => automation.key);
      expect(listedKeys).toEqual([...listedKeys].sort());
      expect(missingFrom(listedKeys, keys)).toEqual([]);
      expect(
        listed.find((automation) => automation.key === keys[0])?.latestVersion
          ?.version,
      ).toBe(1);
    },
  );

  concurrentTest("publishing needs executions:write", async () => {
    const reader = await createMember(fixture, "read");
    const { error } = await publishAutomationRequest(
      fixture,
      wayfinder(),
      reader,
    );
    expect(error?.status).toBe(403);
    const listed = await fixture.apiClient.api
      .projects({ projectId: fixture.projectId })
      .automations.get({ headers: { ...reader } });
    expect(listed.error).toBeNull();
  });
});

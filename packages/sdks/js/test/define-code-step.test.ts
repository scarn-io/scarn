import { inlineEnvironment } from "./inline-environment";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Runtime } from "../src/definitions/steps/runtime";
import { codeStep } from "../src/definitions/steps/define-code-step";
import { Features, Notify } from "../src/definitions/steps/step-features";

describe("codeStep", () => {
  test.concurrent(
    "produces a kind: 'code' spec with no prompt and a live entrypoint.fn",
    () => {
      const fn = (input: { path: string }) => ({ ok: true, path: input.path });
      const spec = codeStep({
        key: "read-file",
        name: "Read File",
        version: 2,
        fn,
        inputSchema: z.object({ path: z.string() }),
        resultSchema: z.object({ ok: z.boolean(), path: z.string() }),
      });

      expect(spec.kind).toBe("code");
      expect(spec.prompt).toBeNull();
      expect(spec.version).toBe(2);
      expect(spec.entrypoint?.fn === fn).toBe(true);
      expect(spec.entrypointJson).toBeUndefined();
      expect(spec.inputSchemaJson).toMatchObject({ type: "object" });
      expect(spec.resultSchemaJson).toMatchObject({ type: "object" });
    },
  );

  test.concurrent("leaves logs out unless it skips succeeded runs", () => {
    const base = { key: "noop", name: "Noop", fn: () => ({}) };
    expect("logs" in codeStep(base)).toBe(false);
    expect("logs" in codeStep({ ...base, logs: { archive: "always" } })).toBe(
      false,
    );
    expect(codeStep({ ...base, logs: { archive: "on-failure" } }).logs).toEqual(
      { archive: "on-failure" },
    );
  });

  test.concurrent("refuses an unknown logs.archive", () => {
    expect(() =>
      codeStep({
        key: "noop",
        name: "Noop",
        fn: () => ({}),
        logs: { archive: "never" as "always" },
      }),
    ).toThrow('logs.archive must be "always" or "on-failure"');
  });

  test.concurrent("defaults version to 1 and status to active", () => {
    const spec = codeStep({
      key: "noop",
      name: "Noop",
      fn: () => ({}),
    });
    expect(spec.version).toBe(1);
    expect(spec.status).toBe("active");
  });

  test.concurrent(
    "an omitted runtime compiles to the default managed identifier",
    () => {
      const spec = codeStep({ key: "noop", name: "Noop", fn: () => ({}) });
      expect(spec.environment).toEqual({
        kind: "inline",
        runtime: { kind: "managed", id: "bun1" },
        envJson: null,
      });
    },
  );

  test.concurrent(
    "an explicit devcontainer runtime replaces the managed default",
    () => {
      const spec = codeStep({
        key: "noop",
        name: "Noop",
        environment: { runtime: Runtime.devcontainer() },
        fn: () => ({}),
      });
      expect(inlineEnvironment(spec.environment)?.runtime).toEqual({
        kind: "devcontainer",
      });
    },
  );

  describe("features", () => {
    test.concurrent(
      "features: [Features.notifications()] wires the result field without a prompt",
      () => {
        const spec = codeStep({
          key: "notify",
          name: "Notify",
          features: [Features.notifications()],
          fn: () => Notify.inApp("Title", "This is the comment", "high"),
        });

        expect(spec.kind).toBe("code");
        expect(spec.prompt).toBeNull();
        expect(spec.resultSchemaJson).toMatchObject({
          properties: { $scarn_notifications_v1: { type: "array" } },
        });
      },
    );

    test.concurrent(
      "Notify.inApp(...) builds a single in-app-suggested notification",
      () => {
        const result = Notify.inApp("Title", "This is the comment", "high");
        expect(result).toEqual({
          $scarn_notifications_v1: [
            {
              kind: "status_update",
              title: "Title",
              body: "This is the comment",
              priority: "high",
              suggestedChannels: ["in_app"],
            },
          ],
        });
      },
    );

    test.concurrent(
      "Notify.inApp(...) accepts an explicit kind and payload",
      () => {
        const result = Notify.inApp("Blocked", "Need input", "urgent", {
          kind: "blocked",
          payload: { category: "infra" },
        });
        expect(result.$scarn_notifications_v1[0]).toMatchObject({
          kind: "blocked",
          suggestedChannels: ["in_app"],
          payload: { category: "infra" },
        });
      },
    );

    test.concurrent(
      "Notify.create(...) suggests any channel directly, without dedicated sugar",
      () => {
        const result = Notify.create({
          kind: "status_update",
          title: "Deployed",
          body: "v2.3.0 is live",
          priority: "normal",
          suggestedChannels: ["slack"],
        });
        expect(result.$scarn_notifications_v1[0]).toMatchObject({
          suggestedChannels: ["slack"],
        });
      },
    );

    test.concurrent(
      "Notify.merge(...) combines fragments from multiple calls",
      () => {
        const result = Notify.merge(
          Notify.inApp("A", "a", "low"),
          Notify.create({
            kind: "status_update",
            title: "B",
            body: "b",
            priority: "normal",
            suggestedChannels: ["email"],
          }),
        );
        expect(result.$scarn_notifications_v1).toHaveLength(2);
        expect(
          result.$scarn_notifications_v1.map((n) => n.suggestedChannels),
        ).toEqual([["in_app"], ["email"]]);
      },
    );

    test.concurrent(
      "a resultSchema declared alongside features merges into one JSON schema",
      () => {
        const spec = codeStep({
          key: "notify-with-status",
          name: "Notify With Status",
          resultSchema: z.object({ status: z.literal("completed") }),
          features: [Features.notifications()],
          fn: () => ({
            status: "completed" as const,
            ...Notify.inApp("Done", "All finished", "normal"),
          }),
        });

        expect(spec.resultSchemaJson).toMatchObject({
          properties: {
            status: { const: "completed" },
            $scarn_notifications_v1: { type: "array" },
          },
        });
      },
    );
  });

  test.concurrent(
    "rejects work item features off project at the type level and at define time",
    () => {
      expect(() =>
        codeStep({
          key: "code-step",
          name: "Code Step",
          fn: () => ({}),
          // @ts-expect-error a code step has no agent tools to use a grant with
          features: [Features.workItems.read({ scope: "self" })],
        }),
      ).toThrow('not read on "self"');
    },
  );
});

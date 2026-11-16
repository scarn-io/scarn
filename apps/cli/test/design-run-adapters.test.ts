import { describe, expect, test } from "bun:test";
import {
  firstPipelineKeyOf,
  stepRuntimeTargetSchema,
  stepNeedsProjectDevcontainer,
} from "../src/lib/design-run-adapters";

/**
 * `firstPipelineKeyOf` is the only thing pinning how the run offer finds the
 * pipeline to run. The generated SDK types an automation's `latestVersion` as
 * `T | unknown`, which TypeScript collapses to plain `unknown`, so the compiler
 * cannot catch a wrong field name here — and a wrong read fails open: the offer
 * would silently decide "no pipeline to run" and never appear.
 *
 * These tests are that missing type check.
 */

const version = (rules: unknown[]) => ({
  document: {
    kind: "automation",
    schemaVersion: 1,
    key: "default",
    scope: "project",
    rules,
  },
});

describe("firstPipelineKeyOf", () => {
  test("reads the first pipeline a route starts", () => {
    expect(
      firstPipelineKeyOf(
        version([
          {
            event: "workItem.ready",
            next: {
              routes: [
                {
                  kind: "skip",
                  when: { path: "event.workItem.title", op: "exists" },
                },
                { kind: "pipeline", to: "bug-pipeline", on: "workItem" },
              ],
            },
          },
        ]),
      ),
    ).toBe("bug-pipeline");
  });

  test("reads an otherwise pipeline", () => {
    expect(
      firstPipelineKeyOf(
        version([
          {
            event: "workItem.ready",
            next: {
              routes: [{ kind: "attach", automation: "wayfinder" }],
              otherwise: { kind: "pipeline", to: "triage", on: "workItem" },
            },
          },
        ]),
      ),
    ).toBe("triage");
  });

  test("is undefined with no version, or no pipeline target", () => {
    expect(firstPipelineKeyOf(null)).toBeUndefined();
    expect(firstPipelineKeyOf(undefined)).toBeUndefined();
    expect(
      firstPipelineKeyOf(
        version([
          { event: "workItem.created", next: { routes: [{ kind: "skip" }] } },
        ]),
      ),
    ).toBeUndefined();
  });
});

describe("stepNeedsProjectDevcontainer", () => {
  test.each([undefined, ".devcontainer/test.json"])(
    "explicit devcontainer with config %s needs the project devcontainer",
    (config) => {
      expect(
        stepNeedsProjectDevcontainer({
          environment: {
            kind: "inline",
            runtime: { kind: "devcontainer", config },
          },
        }),
      ).toBe(true);
    },
  );

  test("a managed-runtime step brings its own container", () => {
    expect(
      stepNeedsProjectDevcontainer({
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "bun1" },
        },
      }),
    ).toBe(false);
  });

  test("a host step does not need the project devcontainer", () => {
    expect(
      stepNeedsProjectDevcontainer({
        environment: { kind: "inline", runtime: { kind: "host" } },
      }),
    ).toBe(false);
  });

  test("reads the execution target off a step definition response", () => {
    const parsed = stepRuntimeTargetSchema.parse({
      id: "019ed1c9-3333-7170-a08a-1ff912085f7b",
      environment: null,
      kind: "user_defined",
    });

    expect(parsed).toEqual({
      environment: null,
    });
  });

  test("repository defaults do not imply a devcontainer", () => {
    expect(stepNeedsProjectDevcontainer({ environment: null })).toBe(false);
    expect(
      stepNeedsProjectDevcontainer({ environment: { kind: "inline" } }),
    ).toBe(false);
    expect(
      stepNeedsProjectDevcontainer({
        environment: { kind: "named", name: "shared" },
      }),
    ).toBe(false);
  });

  test("rejects a legacy response without an explicit runtime kind", () => {
    expect(
      stepRuntimeTargetSchema.safeParse({
        executionMode: "workspace",
        managedRuntime: null,
      }).success,
    ).toBe(false);
  });
});

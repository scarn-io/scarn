/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- lines under @ts-expect-error are invalid on purpose */
/**
 * Type tests for automations: the scope limits the events a rule may name,
 * `r.child` exists only on `child.*` events, `r.label` only on
 * `workItem.label.added`, and `attach` only fits project automations. The
 * `@ts-expect-error` cases sit in `typeOnly`, so they're checked but not run.
 */
import { describe, expect, expectTypeOf, test } from "bun:test";
import { contains, equal, type Placeholder } from "@scarn/sdk/pipelines";
import {
  attach,
  defineAutomation,
  onEvent,
  skip,
  type AutomationDefinition,
} from "@scarn/sdk/automations";
import { plan, research, triage, wayfinder } from "./fixtures/wayfinder";

function typeOnly(run: () => void): void {
  void run;
}

describe("automation types", () => {
  test("defineAutomation keeps its scope", () => {
    expectTypeOf(wayfinder).toEqualTypeOf<AutomationDefinition<"workItem">>();
  });

  test("the scope limits the events", () => {
    typeOnly(() => {
      defineAutomation({
        key: "a",
        scope: "workItem",
        // @ts-expect-error workItem.created is a project event
        rules: [onEvent({ event: "workItem.created", to: plan })],
      });
      defineAutomation({
        key: "b",
        scope: "project",
        // @ts-expect-error child.ready is a work-item event
        rules: [onEvent({ event: "child.ready", to: plan })],
      });
      // @ts-expect-error not an event
      onEvent({ event: "child.reopened", to: plan });
      // @ts-expect-error scope is required
      defineAutomation({ key: "c", rules: [] });
    });
    expect(true).toBe(true);
  });

  test("r.child exists only on child.* events", () => {
    const rule = onEvent({
      event: "child.created",
      to: (r) => {
        expectTypeOf(r.child.title).toEqualTypeOf<Placeholder<string>>();
        expectTypeOf(r.child.labels).toEqualTypeOf<Placeholder<string[]>>();
        expectTypeOf(r.workItem.state).toEqualTypeOf<
          Placeholder<"open" | "closed">
        >();
        return plan().on(r.child);
      },
    });
    expect(
      defineAutomation({ key: "ok", scope: "workItem", rules: [rule] }).document
        .rules[0]?.next.routes[0],
    ).toEqual({ kind: "step", to: "plan", on: "child" });
    typeOnly(() => {
      onEvent({
        event: "self.attached",
        // @ts-expect-error no child on self.attached
        to: (r) => plan().on(r.child),
      });
      onEvent({
        event: "workItem.ready",
        // @ts-expect-error no child on project events
        routes: [{ when: (r) => contains(r.child.labels, "x"), to: plan }],
      });
    });
  });

  test("r.label exists only on workItem.label.added", () => {
    expect(() =>
      onEvent({
        event: "workItem.label.added",
        routes: [{ when: (r) => equal(r.label, "bug"), to: triage }],
      }),
    ).not.toThrow();
    typeOnly(() => {
      onEvent({
        event: "workItem.created",
        // @ts-expect-error no label on workItem.created
        routes: [{ when: (r) => equal(r.label, "bug"), to: triage }],
      });
    });
  });

  test("attach fits project automations only", () => {
    expect(() =>
      defineAutomation({
        key: "p",
        scope: "project",
        rules: [onEvent({ event: "workItem.created", to: attach(wayfinder) })],
      }),
    ).not.toThrow();
    typeOnly(() => {
      // @ts-expect-error attach in a work-item event's rule
      onEvent({ event: "child.ready", to: attach(wayfinder) });
      onEvent({
        event: "child.ready",
        routes: [{ to: skip }],
        // @ts-expect-error attach as otherwise of a work-item rule
        otherwise: () => attach(wayfinder),
      });
      const project = defineAutomation({
        key: "p2",
        scope: "project",
        rules: [],
      });
      // @ts-expect-error only a work-item automation can be attached
      attach(project);
    });
  });

  test("targets: step calls, bare steps, pipelines, skip", () => {
    expect(() =>
      onEvent({
        event: "child.ready",
        match: "all",
        routes: [
          { to: plan },
          { to: triage },
          { to: (r) => triage.on(r.child) },
          { to: (r) => research({ question: r.child.title }) },
          { to: skip },
        ],
      }),
    ).not.toThrow();
    typeOnly(() => {
      // @ts-expect-error research has a required input, so it isn't a bare target
      onEvent({ event: "child.ready", to: research });
      onEvent({
        event: "child.ready",
        // @ts-expect-error a step's args are type-checked
        to: (r) => research({ question: r.child.labels }),
      });
      onEvent({
        event: "child.ready",
        // @ts-expect-error a condition isn't a target
        to: (r) => contains(r.child.labels, "x"),
      });
      // @ts-expect-error otherwise only goes with routes
      onEvent({ event: "child.ready", to: plan, otherwise: skip });
    });
  });
});

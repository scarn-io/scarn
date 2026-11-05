import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NO_PIPELINES,
  WAYFINDER,
  WAYFINDER_GRANTS,
} from "./automation-round-fixtures";
import { buildAutomationRound } from "./automation-round-model";
import { AutomationRoundView } from "./AutomationRoundView";

describe("AutomationRoundView", () => {
  test("renders wayfinder's round in its lanes", () => {
    const html = renderToStaticMarkup(
      <AutomationRoundView
        model={buildAutomationRound(WAYFINDER, WAYFINDER_GRANTS, NO_PIPELINES)}
      />,
    );
    for (const text of [
      "Automation · events &amp; rules",
      "This work item",
      "Child work items",
      "self.attached",
      "child.ready",
      "child.closed",
      "plan",
      "research",
      "A person",
      "Closed",
    ]) {
      expect(html).toContain(text);
    }
  });
});

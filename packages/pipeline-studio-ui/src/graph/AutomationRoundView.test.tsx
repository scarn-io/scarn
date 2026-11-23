import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NO_GRANTS,
  NO_PIPELINES,
  POLLER,
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

  test("renders schedule rules as triggers captioned with their rule keys", () => {
    const html = renderToStaticMarkup(
      <AutomationRoundView
        model={buildAutomationRound(POLLER, NO_GRANTS, NO_PIPELINES)}
      />,
    );
    for (const text of [
      "Scheduled · no work item",
      "0 * * * *",
      "0 9 * * 1-5 Europe/Paris",
      "hourly",
      "weekday-digest",
      "triage-new",
      "poll-linear",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("Rule 1");
  });
});

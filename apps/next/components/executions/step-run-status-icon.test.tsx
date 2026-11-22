import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  StepRunStatusIcon,
  getStepRunStatusLabel,
} from "./step-run-status-icon";
import { installDom } from "@/tests/support/install-dom";

describe("StepRunStatusIcon", () => {
  beforeEach(() => {
    installDom();

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string): MediaQueryList =>
        ({
          addEventListener() {},
          addListener() {},
          dispatchEvent() {
            return false;
          },
          matches: false,
          media: query,
          onchange: null,
          removeEventListener() {},
          removeListener() {},
        }) as MediaQueryList,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("labels a node with no visit as not run", () => {
    expect(getStepRunStatusLabel(null)).toBe("Not run");
    const view = render(<StepRunStatusIcon status={null} />);
    expect(view.container.querySelector("svg")).toBeTruthy();
  });

  test("labels the derived liveness statuses distinctly", () => {
    expect(getStepRunStatusLabel("abandoned")).not.toBe(
      getStepRunStatusLabel("timeout"),
    );
    expect(getStepRunStatusLabel("queued")).not.toBe(
      getStepRunStatusLabel("running"),
    );
  });
});

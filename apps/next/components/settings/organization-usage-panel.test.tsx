import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { UsageMeterContract } from "@scarn/api/frontend-contracts";
import { installDom } from "@/tests/support/install-dom";

// Rendering MUI under jsdom is CPU-heavy; under a loaded machine
// (test-all-workspaces) a single test can overrun bun's 5s default.
const { OrganizationUsagePanel } = await import("./organization-usage-panel");

const usage: UsageMeterContract = {
  orgId: parseUuidV7("019e9a92-b432-73e8-9341-3519156fa900"),
  period: "2026-11",
  planId: "free",
  writes: 10,
  reads: 20,
  signalTokens: 7500,
  storageBytes: 7 * 1024,
  storageBreakdown: {
    artifactBytes: 1024,
    logBytes: 2 * 1024,
    sessionBytes: 4 * 1024,
  },
  limits: {
    maxWritesPerMonth: 1000,
    maxReadsPerMonth: 3000,
    maxStorageBytes: 1024 ** 3 / 4,
    maxSignalTokensPerMonth: 30_000,
  },
  resetsAt: "2026-12-01T00:00:00.000Z",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
};

describe("OrganizationUsagePanel", () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    cleanup();
  });

  test("breaks storage down into artifacts, logs and sessions", () => {
    const view = render(<OrganizationUsagePanel usage={usage} />);

    expect(view.getByText("Artifacts: 1.0 KiB")).toBeTruthy();
    expect(view.getByText("Logs: 2.0 KiB")).toBeTruthy();
    expect(view.getByText("Sessions: 4.0 KiB")).toBeTruthy();
  });

  test("shows push sessions against the monthly limit", () => {
    const view = render(<OrganizationUsagePanel usage={usage} />);

    expect(view.getByText("Push sessions")).toBeTruthy();
    expect(
      view.getByText(
        `${(7500).toLocaleString()} / ${(30_000).toLocaleString()} (25%)`,
      ),
    ).toBeTruthy();
    expect(
      view.getByRole("progressbar", { name: "Push sessions usage" }),
    ).toBeTruthy();
  });

  test("shows usage without a limit or progress bar on an unlimited plan", () => {
    const view = render(
      <OrganizationUsagePanel
        usage={{
          ...usage,
          planId: "unlimited",
          writes: 5000,
          limits: {
            maxWritesPerMonth: null,
            maxReadsPerMonth: null,
            maxStorageBytes: null,
            maxSignalTokensPerMonth: null,
          },
        }}
      />,
    );

    expect(
      view.getByText(`${(5000).toLocaleString()} (no limit)`),
    ).toBeTruthy();
    expect(view.getByText("7.0 KiB (no limit)")).toBeTruthy();
    expect(view.queryAllByRole("progressbar")).toHaveLength(0);
  });
});

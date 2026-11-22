import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env["E2E_BASE_URL"] ?? "http://localhost:3100";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  retries: 1,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
    // Per-operation timeouts so a slow navigation/action fails fast with a
    // precise error (e.g. "page.goto timed out") instead of silently eating
    // the entire 30s/90s test budget and surfacing as a generic test timeout.
    navigationTimeout: 15_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: {
    command: "bun run ./tests/e2e/run-e2e-web-server.ts",
    env: {
      E2E_APP_URL: baseURL,
    },
    url: baseURL,
    reuseExistingServer: !process.env["CI"],
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

/**
 * Keeps `wrangler.jsonc` (local dev and tests) and `deploy.json` (read by the
 * Terraform deploy) from drifting apart, and pins the settings Terraform
 * models outside `deploy.json` (workers.dev subdomain, previews, observability).
 */
import { describe, expect, it } from "vitest";
import deployJson from "../deploy.json";
import wranglerSource from "../wrangler.jsonc?raw";

type Migration = { tag: string; new_sqlite_classes?: string[] };

type RateLimit = {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
};

type AnalyticsEngineDataset = { binding: string; dataset: string };

type WranglerConfig = {
  compatibility_date: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  observability?: { enabled?: boolean };
  durable_objects: { bindings: { name: string; class_name: string }[] };
  migrations: Migration[];
  ratelimits: RateLimit[];
  analytics_engine_datasets: AnalyticsEngineDataset[];
};

function parseJsonc(source: string): unknown {
  const withoutComments = source.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_match, string: string | undefined) => string ?? "",
  );
  const withoutTrailingCommas = withoutComments.replace(
    /("(?:[^"\\]|\\.)*")|,(\s*[}\]])/g,
    (_match, string: string | undefined, closer: string | undefined) =>
      string ?? closer ?? "",
  );
  return JSON.parse(withoutTrailingCommas);
}

const wrangler = parseJsonc(wranglerSource) as WranglerConfig;
const deploy = deployJson as {
  compatibility_date: string;
  main_module: string;
  migrations: Migration[];
  ratelimits: RateLimit[];
  analytics_engine_datasets: AnalyticsEngineDataset[];
};

describe("deploy config", () => {
  it("uses the same compatibility date as wrangler.jsonc", () => {
    expect(deploy.compatibility_date).toBe(wrangler.compatibility_date);
  });

  it("declares the same migrations as wrangler.jsonc", () => {
    expect(deploy.migrations).toEqual(wrangler.migrations);
  });

  it("appends each Durable Object class in its own migration, in order", () => {
    expect(deploy.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["ProjectWorkSignal"] },
      { tag: "v2", new_sqlite_classes: ["TaskRunLogFeed"] },
    ]);
  });

  it("binds the Durable Object namespaces Terraform binds", () => {
    expect(wrangler.durable_objects.bindings).toEqual([
      { name: "PROJECT_WORK_SIGNAL", class_name: "ProjectWorkSignal" },
      { name: "TASK_RUN_LOG_FEED", class_name: "TaskRunLogFeed" },
    ]);
  });

  it("migrates every Durable Object class bound in wrangler.jsonc", () => {
    const bound = wrangler.durable_objects.bindings
      .map((binding) => binding.class_name)
      .sort();
    const migrated = deploy.migrations
      .flatMap((migration) => migration.new_sqlite_classes ?? [])
      .sort();
    expect(migrated).toEqual(bound);
  });

  it("declares the same rate limiters as wrangler.jsonc", () => {
    expect(deploy.ratelimits).toEqual(wrangler.ratelimits);
  });

  it("binds every rate limiter the Worker uses, each in its own namespace", () => {
    expect(deploy.ratelimits.map((limiter) => limiter.name).sort()).toEqual([
      "AUTH_FAIL_LIMITER",
      "FEED_READER_LIMITER",
      "FEED_WRITER_LIMITER",
      "WS_ORG_LIMITER",
      "WS_WORKER_LIMITER",
    ]);
    const namespaces = deploy.ratelimits.map((limiter) => limiter.namespace_id);
    expect(new Set(namespaces).size).toBe(namespaces.length);
  });

  it("uses only the rate-limit periods Cloudflare supports", () => {
    for (const limiter of deploy.ratelimits) {
      expect([10, 60]).toContain(limiter.simple.period);
      expect(limiter.simple.limit).toBeGreaterThan(0);
    }
  });

  it("declares the same Analytics Engine datasets as wrangler.jsonc", () => {
    expect(deploy.analytics_engine_datasets).toEqual(
      wrangler.analytics_engine_datasets,
    );
  });

  it("binds the metering dataset", () => {
    expect(deploy.analytics_engine_datasets).toEqual([
      { binding: "EDGE_EVENTS", dataset: "edge_events" },
    ]);
  });

  it("points at the module wrangler emits", () => {
    expect(deploy.main_module).toBe("index.js");
  });

  it("pins the settings Terraform models outside deploy.json", () => {
    expect(wrangler.workers_dev).toBe(true);
    expect(wrangler.preview_urls).toBe(false);
    expect(wrangler.observability?.enabled).toBe(true);
  });
});

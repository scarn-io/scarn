import { describe, expect, test } from "bun:test";
import { assertConsistentSeedEnvironment } from "./seed-environment-guard";

describe("assertConsistentSeedEnvironment", () => {
  test("allows a fully local environment", () => {
    expect(() => {
      assertConsistentSeedEnvironment({
        DATABASE_URL: "postgres://postgres:postgres@localhost:6429/scarn",
        S3_BUCKET: "scarn-logs",
        S3_ENDPOINT: "http://localhost:9000",
      });
    }).not.toThrow();
  });

  test("allows a fully remote (production-shaped) environment", () => {
    expect(() => {
      assertConsistentSeedEnvironment({
        DATABASE_URL: "postgres://user:pass@ep-something.aws.neon.tech/neondb",
        S3_BUCKET: "scarn-logs-481665083094-us-east-2-an",
        // S3_ENDPOINT intentionally unset — real AWS S3.
      });
    }).not.toThrow();
  });

  test("throws when DATABASE_URL is remote but the object store is local", () => {
    expect(() => {
      assertConsistentSeedEnvironment({
        DATABASE_URL: "postgres://user:pass@ep-something.aws.neon.tech/neondb",
        S3_BUCKET: "scarn-logs",
        S3_ENDPOINT: "http://localhost:9000",
      });
    }).toThrow(/refusing to run/);
  });

  test("throws when DATABASE_URL is local but the object store is remote", () => {
    expect(() => {
      assertConsistentSeedEnvironment({
        DATABASE_URL: "postgres://postgres:postgres@localhost:6429/scarn",
        S3_BUCKET: "scarn-logs-481665083094-us-east-2-an",
      });
    }).toThrow(/refusing to run/);
  });

  test("no-ops when DATABASE_URL is unset", () => {
    expect(() => {
      assertConsistentSeedEnvironment({
        S3_BUCKET: "scarn-logs",
      });
    }).not.toThrow();
  });

  test("no-ops when object storage is disabled (S3_BUCKET unset)", () => {
    expect(() => {
      assertConsistentSeedEnvironment({
        DATABASE_URL: "postgres://user:pass@ep-something.aws.neon.tech/neondb",
      });
    }).not.toThrow();
  });
});

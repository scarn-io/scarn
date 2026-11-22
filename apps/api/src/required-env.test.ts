import { describe, expect, test } from "bun:test";
import {
  API_REQUIRED_ENV,
  MissingEnvError,
  assertRequiredEnv,
  findMissingEnv,
} from "./required-env";

const completeApiEnv = Object.fromEntries(
  API_REQUIRED_ENV.map((key) => [key, "set"]),
);

describe("assertRequiredEnv", () => {
  test("passes when every required variable is set", () => {
    expect(() => {
      assertRequiredEnv(API_REQUIRED_ENV, "api", completeApiEnv);
    }).not.toThrow();
  });

  test("names every missing variable in one error", () => {
    const env = { ...completeApiEnv, APP_URL: undefined, S3_BUCKET: "" };

    let thrown: unknown;
    try {
      assertRequiredEnv(API_REQUIRED_ENV, "api", env);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MissingEnvError);
    const error = thrown as MissingEnvError;
    expect(error.missing).toEqual(["APP_URL", "S3_BUCKET"]);
    expect(error.message).toContain("APP_URL, S3_BUCKET");
    expect(error.message).toContain(".env.selfhost.example");
  });

  test("treats whitespace-only values as missing", () => {
    expect(findMissingEnv(["DATABASE_URL"], { DATABASE_URL: "   " })).toEqual([
      "DATABASE_URL",
    ]);
  });
});

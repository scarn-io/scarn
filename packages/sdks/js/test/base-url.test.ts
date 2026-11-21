import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveScarnAppUrl, resolveScarnBaseUrl } from "../src/defaults";

const savedBaseUrl = process.env["SCARN_BASE_URL"];
const savedAppUrl = process.env["SCARN_APP_URL"];

const restore = (key: "SCARN_BASE_URL" | "SCARN_APP_URL", value?: string) => {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
};

beforeEach(() => {
  restore("SCARN_BASE_URL");
  restore("SCARN_APP_URL");
});

afterEach(() => {
  restore("SCARN_BASE_URL", savedBaseUrl);
  restore("SCARN_APP_URL", savedAppUrl);
});

describe("resolveScarnBaseUrl", () => {
  test("defaults to the API host", () => {
    expect(resolveScarnBaseUrl()).toBe("https://api.scarn.io");
  });

  test("uses SCARN_BASE_URL when no value is given", () => {
    process.env["SCARN_BASE_URL"] = "http://localhost:3000/";
    expect(resolveScarnBaseUrl()).toBe("http://localhost:3000");
  });

  test("prefers an explicit value over the env and trims trailing slashes", () => {
    process.env["SCARN_BASE_URL"] = "http://localhost:3000";
    expect(resolveScarnBaseUrl(" https://scarn.example.com// ")).toBe(
      "https://scarn.example.com",
    );
  });

  test("ignores blank values", () => {
    process.env["SCARN_BASE_URL"] = "  ";
    expect(resolveScarnBaseUrl("")).toBe("https://api.scarn.io");
  });
});

describe("resolveScarnAppUrl", () => {
  test("defaults to the app host", () => {
    expect(resolveScarnAppUrl()).toBe("https://app.scarn.io");
  });

  test("prefers an explicit app URL over everything else", () => {
    process.env["SCARN_APP_URL"] = "https://env-app.example.com";
    process.env["SCARN_BASE_URL"] = "https://env-api.example.com";
    expect(
      resolveScarnAppUrl({
        appUrl: "https://app.example.com/",
        baseUrl: "https://api.example.com",
      }),
    ).toBe("https://app.example.com");
  });

  test("uses SCARN_APP_URL over a configured API URL", () => {
    process.env["SCARN_APP_URL"] = "https://env-app.example.com/";
    expect(resolveScarnAppUrl({ baseUrl: "https://api.example.com" })).toBe(
      "https://env-app.example.com",
    );
  });

  test("falls back to an explicit API URL", () => {
    process.env["SCARN_BASE_URL"] = "https://env-api.example.com";
    expect(resolveScarnAppUrl({ baseUrl: "http://localhost:3000/" })).toBe(
      "http://localhost:3000",
    );
  });

  test("falls back to SCARN_BASE_URL", () => {
    process.env["SCARN_BASE_URL"] = "http://localhost:3000";
    expect(resolveScarnAppUrl()).toBe("http://localhost:3000");
  });

  test("ignores blank values", () => {
    process.env["SCARN_APP_URL"] = " ";
    expect(resolveScarnAppUrl({ appUrl: "", baseUrl: "  " })).toBe(
      "https://app.scarn.io",
    );
  });
});

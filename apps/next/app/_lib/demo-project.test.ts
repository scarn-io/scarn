import { describe, expect, test } from "bun:test";
import { isDemoProjectEnabled } from "./demo-project";

describe("isDemoProjectEnabled", () => {
  test("is off when SCARN_DEMO_PROJECT is unset or not truthy", () => {
    expect(isDemoProjectEnabled({})).toBe(false);
    expect(isDemoProjectEnabled({ SCARN_DEMO_PROJECT: "" })).toBe(false);
    expect(isDemoProjectEnabled({ SCARN_DEMO_PROJECT: "false" })).toBe(false);
    expect(isDemoProjectEnabled({ SCARN_DEMO_PROJECT: "0" })).toBe(false);
    expect(isDemoProjectEnabled({ SCARN_DEMO_PROJECT: "yes" })).toBe(false);
  });

  test("is on for true or 1", () => {
    expect(isDemoProjectEnabled({ SCARN_DEMO_PROJECT: "true" })).toBe(true);
    expect(isDemoProjectEnabled({ SCARN_DEMO_PROJECT: "TRUE" })).toBe(true);
    expect(isDemoProjectEnabled({ SCARN_DEMO_PROJECT: " 1 " })).toBe(true);
  });
});

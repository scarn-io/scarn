import { describe, expect } from "bun:test";
import { readStoredManagedConnectionDiscovery } from "@/connections/managed-mcp-connection/contracts/managed-connection-discovery-stored";
import { concurrentTest } from "tests/utils";
import discoveryFixtures from "../fixtures/discovery.json";

describe("managed connection discovery stored read", () => {
  for (const fixture of discoveryFixtures) {
    concurrentTest(`reads the ${fixture.name} fixture`, () => {
      const read = readStoredManagedConnectionDiscovery(fixture.discovery);
      if (!read.success) throw new Error(read.reason);
      expect<object>(read.value).toEqual(fixture.expected);
    });
  }

  for (const [name, discovery] of [
    ["null", null],
    ["an array", []],
    ["a string", "https://mcp.example.test/"],
    ["a non-string override", { advertisedResource: 42 }],
    ["non-string origins", { endpointOrigins: [1] }],
  ] as const) {
    concurrentTest(`reports ${name} as unreadable`, () => {
      const read = readStoredManagedConnectionDiscovery(discovery);
      expect(read.success).toBe(false);
    });
  }
});

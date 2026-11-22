import { afterAll, afterEach, describe, expect } from "bun:test";
import { serialTest } from "tests/utils";
import { createManagedConnectionHarness } from "./managed-connection-test-support";

describe("managed connection OAuth scope negotiation", () => {
  const harness = createManagedConnectionHarness();
  const { fake } = harness;

  afterEach(() => {
    fake.reset();
  });
  afterAll(async () => {
    await fake.stop();
  });

  serialTest(
    "connect requests resource scopes and confirms a response omitting scope",
    async () => {
      fake.faults.token = "no_scope";
      const connected = await harness.connectToReady("scope-omitted");
      expect(
        new URL(connected.authorizationUrl).searchParams.get("scope"),
      ).toBe("default");
      expect(connected.candidate.grantedScopes).toEqual(["default"]);
      expect(connected.ready.state).toBe("ready");
      expect(connected.ready.grantedScopes).toEqual(["default"]);
      expect(fake.callsTo("token")).toHaveLength(1);
    },
  );

  serialTest(
    "reconnect saves the requested scopes for an omitted scope response",
    async () => {
      const connected = await harness.connectToReady("scope-reconnect");
      fake.reset();
      fake.faults.token = "no_scope";
      const reconnected = await harness.reconnectToCandidate(
        connected.owner,
        connected.projectId,
        connected.connectionId,
      );
      expect(fake.callsTo("authorize")[0]?.params["scope"]).toBe("default");
      expect(reconnected.candidate.grantedScopes).toEqual(["default"]);
      expect(fake.callsTo("token")).toHaveLength(1);
    },
  );

  serialTest(
    "an explicit empty scope response is not replaced with requested scopes",
    async () => {
      fake.scopes = [];
      const connected = await harness.connectToReady("scope-empty");
      expect(
        new URL(connected.authorizationUrl).searchParams.get("scope"),
      ).toBe("default");
      expect(connected.ready.grantedScopes).toEqual([]);
      expect(fake.callsTo("token")).toHaveLength(1);
    },
  );
});

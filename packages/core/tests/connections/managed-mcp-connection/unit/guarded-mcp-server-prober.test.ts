import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  GuardedMcpServerProber,
  resourceMetadataUrlOf,
} from "@/connections/managed-mcp-connection/infra/guarded-mcp-server-prober";
import { ManagedConnectionGuards } from "@/connections/managed-mcp-connection/infra/managed-connection-guards";
import { FakeMcpOAuth } from "tests/connections/support/fake-mcp-oauth";

const SUPPLIED = {
  clientId: "slack-config-client",
  redirectUri: "http://localhost:3118/callback",
};

const proberFor = (fake: FakeMcpOAuth, slackTokenOrigins?: string[]) =>
  new GuardedMcpServerProber(
    new ManagedConnectionGuards({
      loopbackOrigins: [fake.origin, fake.endpointOrigin],
    }),
    slackTokenOrigins === undefined ? {} : { slackTokenOrigins },
  );

const failureOf = async (probed: Promise<object>) => {
  try {
    await probed;
    return null;
  } catch (error) {
    return error;
  }
};

describe("resourceMetadataUrlOf", () => {
  test.each([
    [
      'Bearer resource_metadata="https://a.test/.well-known/x"',
      "https://a.test/.well-known/x",
    ],
    [
      'Bearer error="invalid_token", resource_metadata=https://a.test/m',
      "https://a.test/m",
    ],
    ['Bearer realm="x"', null],
    [null, null],
  ])("reads %p as %p", (challenge, url) => {
    expect(resourceMetadataUrlOf(challenge)).toBe(url);
  });
});

describe("GuardedMcpServerProber on a spec-following server", () => {
  const fake = new FakeMcpOAuth().start();

  afterEach(() => {
    fake.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  test("needs no overrides", async () => {
    const probe = await proberFor(fake).probe(fake.resource, {
      clientSupplied: false,
    });

    expect(probe).toMatchObject({
      resource: fake.resource,
      issuerOrigin: fake.origin,
      endpointOrigins: [fake.origin],
      discovery: {},
    });
  });

  test("takes a resource on the same origin with another path as advertisedResource", async () => {
    fake.protectedResourceOverrides = { resource: `${fake.origin}/v2` };

    const probe = await proberFor(fake).probe(fake.resource, {
      clientSupplied: false,
    });

    expect(probe.discovery).toEqual({
      advertisedResource: `${fake.origin}/v2`,
    });
  });

  test("refuses a resource on another origin", async () => {
    fake.protectedResourceOverrides = {
      resource: "https://elsewhere.test/mcp",
    };

    expect(
      await failureOf(
        proberFor(fake).probe(fake.resource, { clientSupplied: false }),
      ),
    ).toMatchObject({ code: "MANAGED_CONNECTION_DISCOVERY_FAILED" });
  });

  test("still refuses a server without public-client token auth for a client Scarn registers", async () => {
    fake.authorizationServerOverrides = {
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    };

    expect(
      await failureOf(
        proberFor(fake).probe(fake.resource, { clientSupplied: false }),
      ),
    ).toMatchObject({ code: "MANAGED_CONNECTION_DISCOVERY_FAILED" });
    expect(
      await proberFor(fake).probe(fake.resource, { clientSupplied: true }),
    ).toMatchObject({ discovery: {} });
  });
});

describe("GuardedMcpServerProber on a Slack-like server", () => {
  const fake = new FakeMcpOAuth({
    slackLike: true,
    suppliedClient: SUPPLIED,
  }).start();

  afterEach(() => {
    fake.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  test("finds every override", async () => {
    const probe = await proberFor(fake, [fake.endpointOrigin]).probe(
      fake.resource,
      { clientSupplied: true },
    );

    expect(probe).toEqual({
      resource: fake.resource,
      issuer: fake.origin,
      issuerOrigin: fake.origin,
      endpointOrigins: [fake.endpointOrigin],
      supports: { cimd: false, dcr: false },
      discovery: {
        resourceMetadataUrl: `${fake.origin}/.well-known/oauth-protected-resource`,
        advertisedResource: fake.origin,
        endpointOrigins: [fake.endpointOrigin],
        tokenErrors: "slack",
      },
    });
  });

  test("sets tokenErrors only for a token endpoint on a Slack origin", async () => {
    const probe = await proberFor(fake).probe(fake.resource, {
      clientSupplied: true,
    });

    expect(probe.discovery.tokenErrors).toBeUndefined();
  });

  test("treats a server that offers no registration as needing a supplied client", async () => {
    const probe = await proberFor(fake).probe(fake.resource, {
      clientSupplied: false,
    });

    expect(probe.supports).toEqual({ cimd: false, dcr: false });
  });

  test("still applies every other check with the overrides", async () => {
    fake.authorizationServerOverrides = {
      code_challenge_methods_supported: ["plain"],
    };

    expect(
      await failureOf(
        proberFor(fake).probe(fake.resource, { clientSupplied: true }),
      ),
    ).toMatchObject({ code: "MANAGED_CONNECTION_DISCOVERY_FAILED" });
  });
});

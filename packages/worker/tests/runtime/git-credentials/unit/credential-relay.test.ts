/**
 * Unit tests for {@link CredentialRelay} with a fake source: policy denials,
 * masking before return, `quit=1` on deny/none/error, `store`/`erase`
 * handling, and that no audit entry ever carries a secret.
 */
import { describe, expect, test } from "bun:test";
import {
  CredentialRelay,
  type GitCredentialAuditEntry,
} from "../../../../src/runtime/git-credentials/application/credential-relay";
import type { GitCredentialSource } from "../../../../src/runtime/git-credentials/application/git-credential-source";
import { GitCredentialPolicy } from "../../../../src/runtime/git-credentials/domain/git-credential-policy";
import {
  GitCredentialProtocolError,
  type GitCredential,
  type GitCredentialQuery,
} from "../../../../src/runtime/git-credentials/domain/git-credential-protocol";

const USERNAME = "relay-user-7f3a";
const PASSWORD = "ghs_relaySecret0123456789";
const SOURCE_ERROR = "boom: leaked ghs_fromErrorMessage";

const GET_BODY = "protocol=https\nhost=github.com\npath=acme/app.git\n\n";

type Harness = {
  relay: CredentialRelay;
  audits: GitCredentialAuditEntry[];
  events: string[];
  queries: GitCredentialQuery[];
};

function harness(
  behaviour: (query: GitCredentialQuery) => Promise<GitCredential | null>,
): Harness {
  const audits: GitCredentialAuditEntry[] = [];
  const events: string[] = [];
  const queries: GitCredentialQuery[] = [];
  const source: GitCredentialSource = {
    mode: "host",
    get: async (query) => {
      queries.push(query);
      return behaviour(query);
    },
  };
  const relay = new CredentialRelay({
    policy: GitCredentialPolicy.forRepo({
      repoGitUrl: "git@github.com:acme/app.git",
      extraHosts: [],
    }),
    source,
    audit: (entry) => {
      audits.push(entry);
      events.push(`audit:${entry.outcome}`);
    },
    onSecretValues: (values) => {
      events.push(`mask:${values.join(",")}`);
    },
  });
  return { relay, audits, events, queries };
}

const issuing = () =>
  Promise.resolve<GitCredential | null>({
    username: USERNAME,
    password: PASSWORD,
    expiresAt: null,
  });

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

function expectNoSecrets(audits: readonly GitCredentialAuditEntry[]): void {
  const serialized = JSON.stringify(audits);
  for (const secret of [
    USERNAME,
    PASSWORD,
    "ghs_fromErrorMessage",
    "hunter2",
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

describe("CredentialRelay.handleGit get", () => {
  test("issues the credential and masks it before returning", async () => {
    const { relay, audits, events, queries } = harness(issuing);
    const outcome = await relay.handleGit("get", GET_BODY);
    expect(outcome).toEqual({
      status: "issued",
      body: `username=${USERNAME}\npassword=${PASSWORD}\n`,
    });
    expect(events).toEqual([`mask:${PASSWORD}`, "audit:issued"]);
    expect(queries).toEqual([
      { protocol: "https", host: "github.com", path: "acme/app.git" },
    ]);
    expect(audits).toEqual([
      {
        operation: "get",
        protocol: "https",
        host: "github.com",
        path: "acme/app.git",
        source: "host",
        outcome: "issued",
        reason: null,
      },
    ]);
    expectNoSecrets(audits);
  });

  test("a protocol denial answers quit=1 without asking the source", async () => {
    const { relay, audits, queries } = harness(issuing);
    const outcome = await relay.handleGit(
      "get",
      "protocol=http\nhost=github.com\n",
    );
    expect(outcome).toEqual({
      status: "denied",
      body: "quit=1\n",
      reason: "protocol",
    });
    expect(queries).toEqual([]);
    expect(audits).toMatchObject([{ outcome: "denied", reason: "protocol" }]);
  });

  test("a host denial answers quit=1 and audits the reason", async () => {
    const { relay, audits, queries } = harness(issuing);
    const outcome = await relay.handleGit(
      "get",
      "protocol=https\nhost=gitlab.com\npath=x/y\n",
    );
    expect(outcome).toEqual({
      status: "denied",
      body: "quit=1\n",
      reason: "host",
    });
    expect(queries).toEqual([]);
    expect(audits).toMatchObject([
      { host: "gitlab.com", outcome: "denied", reason: "host" },
    ]);
  });

  test("no credential from the source answers quit=1 with outcome none", async () => {
    const { relay, audits, events } = harness(() => Promise.resolve(null));
    expect(await relay.handleGit("get", GET_BODY)).toEqual({
      status: "none",
      body: "quit=1\n",
    });
    expect(events).toEqual(["audit:none"]);
    expect(audits).toMatchObject([{ outcome: "none", reason: null }]);
  });

  test("a source error is audited as error and never echoed", async () => {
    const { relay, audits, events } = harness(() =>
      Promise.reject(new Error(SOURCE_ERROR)),
    );
    const outcome = await relay.handleGit("get", GET_BODY);
    expect(outcome).toEqual({ status: "none", body: "quit=1\n" });
    expect(JSON.stringify(outcome)).not.toContain("boom");
    expect(events).toEqual(["audit:error"]);
    expect(audits).toMatchObject([{ outcome: "error" }]);
    expectNoSecrets(audits);
  });

  test("a malformed get is a protocol error", async () => {
    const { relay, audits } = harness(issuing);
    expect(
      await rejectionOf(relay.handleGit("get", "host=github.com\n")),
    ).toBeInstanceOf(GitCredentialProtocolError);
    expect(audits).toEqual([]);
  });
});

describe("CredentialRelay.handleGit store / erase / other", () => {
  const storeBody = `${GET_BODY.trimEnd()}\nusername=${USERNAME}\npassword=hunter2\n\n`;

  test("store is ignored without asking the source or auditing", async () => {
    const { relay, audits, queries } = harness(issuing);
    expect(await relay.handleGit("store", storeBody)).toEqual({
      status: "ignored",
    });
    expect(queries).toEqual([]);
    expect(audits).toEqual([]);
  });

  test("erase is audited without its secret and ignored", async () => {
    const { relay, audits, queries } = harness(issuing);
    expect(await relay.handleGit("erase", storeBody)).toEqual({
      status: "ignored",
    });
    expect(queries).toEqual([]);
    expect(audits).toEqual([
      {
        operation: "erase",
        protocol: "https",
        host: "github.com",
        path: "acme/app.git",
        source: "host",
        outcome: "ignored",
        reason: null,
      },
    ]);
    expectNoSecrets(audits);
  });

  test("an unparseable erase is still audited and ignored", async () => {
    const { relay, audits } = harness(issuing);
    expect(await relay.handleGit("erase", "password=hunter2\n")).toEqual({
      status: "ignored",
    });
    expect(audits).toMatchObject([
      { operation: "erase", host: null, outcome: "ignored" },
    ]);
    expectNoSecrets(audits);
  });

  test("any other operation is a protocol error", async () => {
    const { relay } = harness(issuing);
    for (const operation of ["fill", "approve", "", "GET"]) {
      expect(
        await rejectionOf(relay.handleGit(operation, GET_BODY)),
      ).toBeInstanceOf(GitCredentialProtocolError);
    }
  });
});

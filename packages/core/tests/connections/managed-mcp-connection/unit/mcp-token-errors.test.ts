import { describe, expect, test } from "bun:test";
import {
  exchangeFailureOf,
  refreshFailureOf,
} from "@/connections/managed-mcp-connection/infra/mcp-token-errors";

const body = (value: object) => JSON.stringify(value);

describe("refreshFailureOf", () => {
  test.each([
    ["invalid_refresh_token", "rejected"],
    ["invalid_grant", "rejected"],
    ["token_revoked", "rejected"],
    ["invalid_client_id", "client_rejected"],
    ["bad_client_secret", "client_rejected"],
    ["ratelimited", "unknown"],
  ] as const)("reads Slack's 200 ok:false %s as %s", (error, status) => {
    expect(refreshFailureOf(200, body({ ok: false, error }), "slack")).toEqual({
      status,
    });
  });

  test("reads a Slack ok:false without an error as unknown", () => {
    expect(refreshFailureOf(200, body({ ok: false }), "slack")).toEqual({
      status: "unknown",
    });
  });

  test("leaves a 200 ok:false to the success parser without the override", () => {
    expect(
      refreshFailureOf(
        200,
        body({ ok: false, error: "invalid_refresh_token" }),
        undefined,
      ),
    ).toBeNull();
  });

  test("leaves a Slack ok:true to the success parser", () => {
    expect(
      refreshFailureOf(200, body({ ok: true, access_token: "a" }), "slack"),
    ).toBeNull();
  });

  test.each([undefined, "slack"] as const)(
    "still reads OAuth errors and 5xx with tokenErrors %p",
    (tokenErrors) => {
      expect(
        refreshFailureOf(400, body({ error: "invalid_grant" }), tokenErrors),
      ).toEqual({ status: "rejected" });
      expect(
        refreshFailureOf(401, body({ error: "invalid_client" }), tokenErrors),
      ).toEqual({ status: "client_rejected" });
      expect(refreshFailureOf(400, "not json", tokenErrors)).toEqual({
        status: "unknown",
      });
      expect(refreshFailureOf(503, "", tokenErrors)).toEqual({
        status: "server_error",
      });
    },
  );
});

describe("exchangeFailureOf", () => {
  test.each([
    ["invalid_code", "exchange_failed"],
    ["invalid_grant", "exchange_failed"],
    ["invalid_client_id", "client_configuration"],
    ["bad_client_secret", "client_configuration"],
  ] as const)("reads Slack's 200 ok:false %s as %s", (error, failureCode) => {
    expect(exchangeFailureOf(200, body({ ok: false, error }), "slack")).toBe(
      failureCode,
    );
  });

  test("leaves successes to the parser and keeps 5xx unknown", () => {
    expect(exchangeFailureOf(200, body({ ok: true }), "slack")).toBeNull();
    expect(
      exchangeFailureOf(200, body({ ok: false, error: "x" }), undefined),
    ).toBeNull();
    expect(exchangeFailureOf(500, "", "slack")).toBe("exchange_unknown");
  });
});

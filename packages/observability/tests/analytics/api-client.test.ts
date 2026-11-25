import { describe, expect, test } from "bun:test";
import {
  apiClientHeaders,
  readApiClient,
} from "../../src/analytics/api-client";

describe("readApiClient", () => {
  test("round-trips the headers a client sends", () => {
    expect(
      readApiClient(new Headers(apiClientHeaders("cli", "1.4.2"))),
    ).toEqual({ client: "cli", client_version: "1.4.2" });
    expect(readApiClient(new Headers(apiClientHeaders("web")))).toEqual({
      client: "web",
    });
  });

  test("reports unknown when the header is missing or not a known client", () => {
    expect(readApiClient(new Headers())).toEqual({ client: "unknown" });
    expect(
      readApiClient(
        new Headers({
          "x-scarn-client": "curl",
          "x-scarn-client-version": "1.0.0",
        }),
      ),
    ).toEqual({ client: "unknown" });
  });

  test("normalizes the client name's case and whitespace", () => {
    expect(readApiClient(new Headers({ "x-scarn-client": " CLI " }))).toEqual({
      client: "cli",
    });
  });

  test("drops a version that doesn't look like one", () => {
    expect(
      readApiClient(
        new Headers({
          "x-scarn-client": "cli",
          "x-scarn-client-version": "<script>",
        }),
      ),
    ).toEqual({ client: "cli" });
    expect(
      readApiClient(
        new Headers({
          "x-scarn-client": "cli",
          "x-scarn-client-version": "1".repeat(65),
        }),
      ),
    ).toEqual({ client: "cli" });
  });
});

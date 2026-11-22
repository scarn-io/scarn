import { describe, expect } from "bun:test";
import {
  isLoopbackRedirectUri,
  parseLoopbackRedirectUri,
} from "@/connections/managed-mcp-connection/domain/loopback-redirect";
import { CoreError } from "@/lib/errors";
import { concurrentTest } from "tests/utils";

const accepted = [
  "http://127.0.0.1/callback",
  "http://127.0.0.1:53682/callback",
  "http://127.0.0.1:28418/",
  "http://127.0.0.1:1/deep/path?x=1",
  "http://[::1]:8080/callback",
  "http://[::1]/callback",
  "http://localhost/callback",
  "http://localhost:3118/oauth/callback",
  "HTTP://LOCALHOST:3118/callback",
];

const refused = [
  "https://127.0.0.1/callback",
  "https://localhost:3118/callback",
  "http://127.0.0.2/callback",
  "http://127.1/callback",
  "http://0x7f000001/callback",
  "http://[::2]/callback",
  "http://[0:0:0:0:0:0:0:1]/callback",
  "http://example.com/callback",
  "http://localhost.example.com/callback",
  "http://user@127.0.0.1/callback",
  "http://user:pass@localhost/callback",
  "http://@localhost/callback",
  "http://127.0.0.1/callback#frag",
  "http://127.0.0.1/callback#",
  "ftp://127.0.0.1/callback",
  "127.0.0.1:53682/callback",
  "not a url",
  "",
];

describe("loopback redirect", () => {
  concurrentTest("accepts loopback hosts on any port and path", () => {
    for (const uri of accepted) {
      expect(isLoopbackRedirectUri(uri)).toBe(true);
      expect(parseLoopbackRedirectUri(uri)).toBe(uri);
    }
  });

  concurrentTest("refuses other schemes, hosts, userinfo and fragments", () => {
    for (const uri of refused) {
      expect(isLoopbackRedirectUri(uri)).toBe(false);
      let error: unknown;
      try {
        parseLoopbackRedirectUri(uri);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CoreError);
      expect((error as CoreError).code).toBe(
        "MANAGED_CONNECTION_REDIRECT_INVALID",
      );
      expect((error as CoreError).status).toBe(422);
    }
  });
});

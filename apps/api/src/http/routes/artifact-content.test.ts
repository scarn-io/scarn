import { describe, expect, test } from "bun:test";
import { setRequestClientIp } from "../client-ip";
import { contentClientIp } from "./artifact-content";

const request = (headers: Record<string, string> = {}) =>
  new Request("https://content.example.test/s/t/", { headers });

describe("contentClientIp", () => {
  test("never trusts X-Forwarded-For", () => {
    const spoofed = request({ "x-forwarded-for": "1.2.3.4" });
    expect(contentClientIp(spoofed, false)).toBeNull();
    expect(contentClientIp(spoofed, true)).toBeNull();
  });

  test("uses CloudFront-Viewer-Address only behind CloudFront", () => {
    const viaCloudFront = request({
      "cloudfront-viewer-address": "203.0.113.9:51234",
    });
    expect(contentClientIp(viaCloudFront, true)).toBe("203.0.113.9");
    expect(contentClientIp(viaCloudFront, false)).toBeNull();

    const ipv6 = request({
      "cloudfront-viewer-address": "2001:db8::1:443",
    });
    expect(contentClientIp(ipv6, true)).toBe("2001:db8::1");
  });

  test("falls back to the peer address the entry recorded", () => {
    const direct = request();
    setRequestClientIp(direct, "198.51.100.7");
    expect(contentClientIp(direct, false)).toBe("198.51.100.7");
    expect(contentClientIp(direct, true)).toBeNull();
  });
});

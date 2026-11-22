import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  verifyWebhookSignature,
  WebhookSignatureError,
} from "./verify-webhook-signature";

const SECRET = "test-webhook-secret";
const sign = (body: string): string =>
  `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("verifyWebhookSignature", () => {
  test("accepts a valid signature", () => {
    const body = JSON.stringify({ action: "deleted" });
    expect(() => {
      verifyWebhookSignature({
        rawBody: body,
        signatureHeader: sign(body),
        secret: SECRET,
      });
    }).not.toThrow();
  });

  test("rejects when header is missing", () => {
    expect(() => {
      verifyWebhookSignature({
        rawBody: "{}",
        signatureHeader: null,
        secret: SECRET,
      });
    }).toThrow(WebhookSignatureError);
  });

  test("rejects when header is malformed", () => {
    expect(() => {
      verifyWebhookSignature({
        rawBody: "{}",
        signatureHeader: "sha1=deadbeef",
        secret: SECRET,
      });
    }).toThrow(WebhookSignatureError);
  });

  test("rejects when signature does not match the body", () => {
    const body = JSON.stringify({ action: "deleted" });
    const tamperedSig = sign(body + "tamper");
    expect(() => {
      verifyWebhookSignature({
        rawBody: body,
        signatureHeader: tamperedSig,
        secret: SECRET,
      });
    }).toThrow(WebhookSignatureError);
  });

  test("rejects when signature is computed with a different secret", () => {
    const body = JSON.stringify({ action: "deleted" });
    const wrongSig = `sha256=${createHmac("sha256", "other-secret")
      .update(body)
      .digest("hex")}`;
    expect(() => {
      verifyWebhookSignature({
        rawBody: body,
        signatureHeader: wrongSig,
        secret: SECRET,
      });
    }).toThrow(WebhookSignatureError);
  });
});

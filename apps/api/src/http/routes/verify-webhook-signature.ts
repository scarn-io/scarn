import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

export class WebhookSignatureError extends Error {
  constructor(
    message: string,
    public readonly reason: "missing_header" | "malformed" | "mismatch",
  ) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export const verifyWebhookSignature = (input: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
}): void => {
  if (!input.signatureHeader) {
    throw new WebhookSignatureError(
      "Missing X-Hub-Signature-256 header",
      "missing_header",
    );
  }
  if (!input.signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    throw new WebhookSignatureError(
      "Malformed X-Hub-Signature-256 header",
      "malformed",
    );
  }

  const provided = input.signatureHeader.slice(SIGNATURE_PREFIX.length);
  const expected = createHmac("sha256", input.secret)
    .update(input.rawBody)
    .digest("hex");

  const providedBuffer = Buffer.from(provided, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (
    providedBuffer.length === 0 ||
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new WebhookSignatureError("Webhook signature mismatch", "mismatch");
  }
};

import { ConfigurationError } from "@scarn/core/lib/errors";
import type {
  EncryptedSecretValue,
  SecretCipher,
} from "@scarn/core/secrets/secret/application/secret-cipher";
import { AesGcmSecretCipher } from "./aes-gcm-secret-cipher";

const ENV_VAR = "SECRETS_ENCRYPTION_KEY";
const KEY_VERSION = 1;
const KEY_LENGTH_BYTES = 32;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

/**
 * Builds the `SecretCipher` from `SECRETS_ENCRYPTION_KEY` (standard base64,
 * decoding to exactly 32 bytes) as key version 1. Throws a
 * `ConfigurationError` when the key is missing or invalid; the error message
 * never contains the value.
 */
export const loadSecretCipherFromEnv = (
  env: Record<string, string | undefined> = process.env,
): AesGcmSecretCipher => {
  const raw = env[ENV_VAR]?.trim();
  if (!raw) {
    throw new ConfigurationError(
      `${ENV_VAR} is not set`,
      "SECRETS_ENCRYPTION_KEY_NOT_SET",
    );
  }
  if (raw.length % 4 !== 0 || !BASE64_PATTERN.test(raw)) {
    throw new ConfigurationError(
      `${ENV_VAR} is not valid base64`,
      "SECRETS_ENCRYPTION_KEY_INVALID",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new ConfigurationError(
      `${ENV_VAR} must decode to exactly ${String(KEY_LENGTH_BYTES)} bytes (got ${String(key.length)})`,
      "SECRETS_ENCRYPTION_KEY_INVALID",
    );
  }
  return new AesGcmSecretCipher({
    keys: new Map([[KEY_VERSION, key]]),
    currentKeyVersion: KEY_VERSION,
  });
};

/**
 * A `SecretCipher` that loads its real cipher from the environment on first
 * use. Keeps `createAppContext()` import-safe (e.g. while `next build`
 * evaluates route modules) while the API entrypoint calls
 * `loadSecretCipherFromEnv()` at startup to fail fast on a bad key.
 */
export class LazySecretCipher implements SecretCipher {
  private delegate: SecretCipher | null = null;

  constructor(
    private readonly resolve: () => SecretCipher = () =>
      loadSecretCipherFromEnv(),
  ) {}

  encrypt(plaintext: string, aad: string): EncryptedSecretValue {
    return this.getDelegate().encrypt(plaintext, aad);
  }

  decrypt(value: EncryptedSecretValue, aad: string): string {
    return this.getDelegate().decrypt(value, aad);
  }

  private getDelegate(): SecretCipher {
    this.delegate ??= this.resolve();
    return this.delegate;
  }
}

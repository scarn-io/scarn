import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ConfigurationError, CoreError } from "@scarn/core/lib/errors";
import type {
  EncryptedSecretValue,
  SecretCipher,
} from "@scarn/core/secrets/secret/application/secret-cipher";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

export type AesGcmSecretCipherConfig = {
  keys: ReadonlyMap<number, Buffer>;
  currentKeyVersion: number;
};

/**
 * AES-256-GCM `SecretCipher` using `node:crypto`. Each encryption uses a fresh
 * random 12-byte IV and produces a 16-byte auth tag. Holds every known key by
 * version: encrypts with `currentKeyVersion` and decrypts with whichever
 * version the stored value names, so keys can be rotated later.
 */
export class AesGcmSecretCipher implements SecretCipher {
  private readonly keys: ReadonlyMap<number, Buffer>;
  private readonly currentKeyVersion: number;

  constructor({ keys, currentKeyVersion }: AesGcmSecretCipherConfig) {
    for (const [version, key] of keys) {
      if (key.length !== KEY_LENGTH_BYTES) {
        throw new ConfigurationError(
          `Secret encryption key version ${String(version)} must be ${String(KEY_LENGTH_BYTES)} bytes`,
          "SECRET_ENCRYPTION_KEY_INVALID",
        );
      }
    }
    if (!keys.has(currentKeyVersion)) {
      throw new ConfigurationError(
        `No secret encryption key for current key version ${String(currentKeyVersion)}`,
        "SECRET_KEY_VERSION_UNKNOWN",
      );
    }
    this.keys = new Map(keys);
    this.currentKeyVersion = currentKeyVersion;
  }

  encrypt(plaintext: string, aad: string): EncryptedSecretValue {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(
      ALGORITHM,
      this.keyFor(this.currentKeyVersion),
      iv,
      { authTagLength: AUTH_TAG_LENGTH_BYTES },
    );
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext,
      iv,
      authTag: cipher.getAuthTag(),
      keyVersion: this.currentKeyVersion,
    };
  }

  decrypt(value: EncryptedSecretValue, aad: string): string {
    const key = this.keyFor(value.keyVersion);
    if (
      value.iv.length !== IV_LENGTH_BYTES ||
      value.authTag.length !== AUTH_TAG_LENGTH_BYTES
    ) {
      throw decryptionFailed();
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, value.iv, {
        authTagLength: AUTH_TAG_LENGTH_BYTES,
      });
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(value.authTag);
      return Buffer.concat([
        decipher.update(value.ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw decryptionFailed();
    }
  }

  private keyFor(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) {
      throw new ConfigurationError(
        `No secret encryption key for key version ${String(version)}`,
        "SECRET_KEY_VERSION_UNKNOWN",
      );
    }
    return key;
  }
}

const decryptionFailed = () =>
  new CoreError({
    code: "SECRET_DECRYPTION_FAILED",
    message: "Secret value could not be decrypted",
    status: 500,
    expose: false,
  });

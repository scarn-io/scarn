import { describe, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { ConfigurationError, CoreError } from "@/lib/errors";
import type { EncryptedSecretValue } from "@/secrets/secret/application/secret-cipher";
import { secretAad } from "@/secrets/secret/domain/secret-aad";
import { userSecretOwner } from "@/secrets/secret/domain/secret-owner";
import { AesGcmSecretCipher } from "@/secrets/secret/infra/aes-gcm-secret-cipher";
import { concurrentTest } from "tests/utils";

const PLAINTEXT = "atlassian-api-token-1234";

const cipherWithKeys = (keys: [number, Buffer][], currentKeyVersion: number) =>
  new AesGcmSecretCipher({ keys: new Map(keys), currentKeyVersion });

const newCipher = () => cipherWithKeys([[1, randomBytes(32)]], 1);

const newAad = () =>
  secretAad({ id: createUuidV7(), owner: userSecretOwner(createUuidV7()) });

const flipFirstByte = (buffer: Buffer): Buffer => {
  const copy = Buffer.from(buffer);
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
};

const expectDecryptionFailure = (fn: () => string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe("SECRET_DECRYPTION_FAILED");
    expect((error as CoreError).message).not.toContain(PLAINTEXT);
    return;
  }
  throw new Error("Expected decryption to fail");
};

describe("AesGcmSecretCipher", () => {
  concurrentTest("decrypts what it encrypted", () => {
    const cipher = newCipher();
    const aad = newAad();

    const encrypted = cipher.encrypt(PLAINTEXT, aad);

    expect(encrypted.iv.length).toBe(12);
    expect(encrypted.authTag.length).toBe(16);
    expect(encrypted.keyVersion).toBe(1);
    expect(encrypted.ciphertext.toString("utf8")).not.toContain(PLAINTEXT);
    expect(cipher.decrypt(encrypted, aad)).toBe(PLAINTEXT);
  });

  concurrentTest(
    "uses a fresh IV and ciphertext for each encryption of the same text",
    () => {
      const cipher = newCipher();
      const aad = newAad();

      const first = cipher.encrypt(PLAINTEXT, aad);
      const second = cipher.encrypt(PLAINTEXT, aad);

      expect(first.iv.equals(second.iv)).toBe(false);
      expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    },
  );

  concurrentTest("fails to decrypt with a different AAD", () => {
    const cipher = newCipher();
    const encrypted = cipher.encrypt(PLAINTEXT, newAad());

    expectDecryptionFailure(() => cipher.decrypt(encrypted, newAad()));
  });

  concurrentTest("fails to decrypt a changed ciphertext", () => {
    const cipher = newCipher();
    const aad = newAad();
    const encrypted = cipher.encrypt(PLAINTEXT, aad);

    expectDecryptionFailure(() =>
      cipher.decrypt(
        { ...encrypted, ciphertext: flipFirstByte(encrypted.ciphertext) },
        aad,
      ),
    );
  });

  concurrentTest("fails to decrypt with a changed auth tag", () => {
    const cipher = newCipher();
    const aad = newAad();
    const encrypted = cipher.encrypt(PLAINTEXT, aad);

    expectDecryptionFailure(() =>
      cipher.decrypt(
        { ...encrypted, authTag: flipFirstByte(encrypted.authTag) },
        aad,
      ),
    );
  });

  concurrentTest("fails to decrypt with a truncated auth tag", () => {
    const cipher = newCipher();
    const aad = newAad();
    const encrypted = cipher.encrypt(PLAINTEXT, aad);

    expectDecryptionFailure(() =>
      cipher.decrypt(
        { ...encrypted, authTag: encrypted.authTag.subarray(0, 4) },
        aad,
      ),
    );
  });

  concurrentTest("rejects an unknown key version with a clear error", () => {
    const cipher = newCipher();
    const aad = newAad();
    const encrypted: EncryptedSecretValue = {
      ...cipher.encrypt(PLAINTEXT, aad),
      keyVersion: 7,
    };

    expect(() => cipher.decrypt(encrypted, aad)).toThrow(ConfigurationError);
    expect(() => cipher.decrypt(encrypted, aad)).toThrow(
      "No secret encryption key for key version 7",
    );
  });

  concurrentTest(
    "encrypts with the current version and decrypts older versions",
    () => {
      const oldKey = randomBytes(32);
      const aad = newAad();
      const oldValue = cipherWithKeys([[1, oldKey]], 1).encrypt(PLAINTEXT, aad);

      const rotated = cipherWithKeys(
        [
          [1, oldKey],
          [2, randomBytes(32)],
        ],
        2,
      );

      expect(rotated.decrypt(oldValue, aad)).toBe(PLAINTEXT);
      expect(rotated.encrypt(PLAINTEXT, aad).keyVersion).toBe(2);
    },
  );

  concurrentTest("rejects a current key version it has no key for", () => {
    expect(() => cipherWithKeys([[1, randomBytes(32)]], 2)).toThrow(
      ConfigurationError,
    );
  });

  concurrentTest("rejects a key that is not 32 bytes", () => {
    expect(() => cipherWithKeys([[1, randomBytes(16)]], 1)).toThrow(
      ConfigurationError,
    );
  });
});

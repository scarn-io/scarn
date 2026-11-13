import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setHomeDirForTests } from "@scarn/sdk/defaults";
import {
  InvalidWorkerInstanceError,
  resolveWorkerInstance,
} from "../../../../src/work/worker-host/domain/worker-instance";
import {
  ensureWorkerInstanceDir,
  workerDiscoveryFilePath,
  workerInstanceDir,
  workerLogFilePath,
  writePrivateFile,
} from "../../../../src/work/worker-host/infra/worker-instance-paths";

describe("resolveWorkerInstance", () => {
  test("defaults to scarn", () => {
    expect(resolveWorkerInstance({})).toBe("scarn");
  });

  test("uses the CLI name the wrapper was invoked as", () => {
    expect(resolveWorkerInstance({ SCARN_CLI_NAME: "scarn-dev" })).toBe(
      "scarn-dev",
    );
  });

  test("strips Windows launcher extensions from the CLI name", () => {
    expect(resolveWorkerInstance({ SCARN_CLI_NAME: "scarn.cmd" })).toBe(
      "scarn",
    );
    expect(resolveWorkerInstance({ SCARN_CLI_NAME: "scarn-dev.exe" })).toBe(
      "scarn-dev",
    );
  });

  test("SCARN_WORKER_INSTANCE wins over the CLI name", () => {
    expect(
      resolveWorkerInstance({
        SCARN_WORKER_INSTANCE: "staging-2",
        SCARN_CLI_NAME: "scarn-dev",
      }),
    ).toBe("staging-2");
  });

  test("blank values fall through", () => {
    expect(
      resolveWorkerInstance({
        SCARN_WORKER_INSTANCE: "  ",
        SCARN_CLI_NAME: "",
      }),
    ).toBe("scarn");
  });

  test.each(["Scarn", "scarn dev", "../etc", "scarn_dev", "a/b", "scarn."])(
    "rejects invalid name %p",
    (name) => {
      expect(() =>
        resolveWorkerInstance({ SCARN_WORKER_INSTANCE: name }),
      ).toThrow(InvalidWorkerInstanceError);
    },
  );

  test("rejects an invalid CLI name and reports its source", () => {
    try {
      resolveWorkerInstance({ SCARN_CLI_NAME: "My Scarn" });
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidWorkerInstanceError);
      expect((error as InvalidWorkerInstanceError).source).toBe(
        "SCARN_CLI_NAME",
      );
    }
  });
});

describe("worker instance paths", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "scarn-worker-paths-"));
    setHomeDirForTests(home);
  });

  afterEach(() => {
    setHomeDirForTests(undefined);
    rmSync(home, { recursive: true, force: true });
  });

  test("lives under ~/.scarn/workers/<instance>", () => {
    const dir = path.join(home, ".scarn", "workers", "scarn-dev");
    expect(workerInstanceDir("scarn-dev")).toBe(dir);
    expect(workerDiscoveryFilePath("scarn-dev")).toBe(
      path.join(dir, "worker.json"),
    );
    expect(workerLogFilePath("scarn-dev")).toBe(path.join(dir, "worker.log"));
  });

  test("refuses invalid instance names", () => {
    expect(() => workerInstanceDir("../escape")).toThrow();
  });

  test.skipIf(process.platform === "win32")(
    "creates a private directory and private files",
    () => {
      const dir = ensureWorkerInstanceDir("scarn");
      expect(statSync(dir).mode & 0o777).toBe(0o700);

      const file = workerDiscoveryFilePath("scarn");
      writePrivateFile(file, "{}");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    },
  );

  test("skips chmod on Windows", () => {
    const dir = ensureWorkerInstanceDir("scarn", "win32");
    const file = path.join(dir, "worker.json");
    writePrivateFile(file, "{}", "win32");
    expect(statSync(file).isFile()).toBe(true);
  });
});

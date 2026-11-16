import { describe, expect, test } from "bun:test";
import {
  buildDockerEnvByName,
  dockerProcessEnv,
} from "../../../../src/runtime/runtime-service/infra/docker-env-flags";

describe("buildDockerEnvByName", () => {
  test.concurrent(
    "names each variable in a -e flag and keeps values in env",
    () => {
      expect(
        buildDockerEnvByName({ ACCOUNT_ID: "acct-1", LOG_LEVEL: "info" }),
      ).toEqual({
        flags: ["-e", "ACCOUNT_ID", "-e", "LOG_LEVEL"],
        env: { ACCOUNT_ID: "acct-1", LOG_LEVEL: "info" },
      });
    },
  );

  test.concurrent("returns nothing for empty or missing layers", () => {
    expect(buildDockerEnvByName({}, undefined)).toEqual({ flags: [], env: {} });
  });

  test.concurrent("no value appears in the built argv", () => {
    const values = {
      URL: "https://x.example.com/?a=b&c=d",
      SPACED: "two words",
      QUOTED: `it's "quoted" $HOME`,
      MULTILINE: "line1\nline2",
      TOKEN: "synthetic-secret-value",
    };
    const { flags, env } = buildDockerEnvByName(values);
    for (const value of Object.values(values)) {
      expect(flags.some((flag) => flag.includes(value))).toBe(false);
    }
    expect(flags.every((flag) => flag === "-e" || !flag.includes("="))).toBe(
      true,
    );
    expect(env).toEqual(values);
  });

  test.concurrent("later layers win and each name is flagged once", () => {
    expect(
      buildDockerEnvByName(
        { TOKEN: "provider", BASE_URL: "u" },
        { TOKEN: "step" },
      ),
    ).toEqual({
      flags: ["-e", "TOKEN", "-e", "BASE_URL"],
      env: { TOKEN: "step", BASE_URL: "u" },
    });
  });
});

describe("dockerProcessEnv", () => {
  test.concurrent("layers the values over the worker's own environment", () => {
    const env = dockerProcessEnv(
      buildDockerEnvByName({ SCARN_TEST_STEP_VAR: "v" }),
    );
    expect(env["PATH"]).toBe(process.env["PATH"]);
    expect(env["SCARN_TEST_STEP_VAR"]).toBe("v");
  });
});

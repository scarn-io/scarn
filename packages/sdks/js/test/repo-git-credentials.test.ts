import { describe, expect, test } from "bun:test";
import { Repo, Runtime, defineStep } from "../src";
import { compileRepo } from "../src/definitions/steps/repo";

describe("Repo gitCredentials", () => {
  test("readOnly(opts) and readWrite(opts) keep gitCredentials", () => {
    expect(Repo.readOnly({ gitCredentials: "none" })).toEqual({
      mode: "readOnly",
      gitCredentials: "none",
    });
    expect(Repo.readWrite({ gitCredentials: "none" })).toEqual({
      mode: "readWrite",
      gitCredentials: "none",
    });
    // @ts-expect-error only "auto" and "none"
    Repo.readOnly({ gitCredentials: "write" });
  });

  test("compileRepo passes gitCredentials through only when set", () => {
    expect(
      compileRepo(Repo.readOnly({ gitCredentials: "none" }), undefined),
    ).toEqual({ mode: "readOnly", gitCredentials: "none" });
    expect(
      compileRepo(
        Repo.readWrite({ gitCredentials: "none", onPushFailure: "warn" }),
        undefined,
      ),
    ).toEqual({
      mode: "readWrite",
      gitCredentials: "none",
      onPushFailure: "warn",
    });
    expect(
      compileRepo(Repo.readOnly({ gitCredentials: "auto" }), undefined),
    ).toEqual({ mode: "readOnly", gitCredentials: "auto" });
    const omitted = compileRepo(
      { mode: "readOnly", gitCredentials: undefined },
      undefined,
    );
    expect(Object.keys(omitted ?? {})).toEqual(["mode"]);
  });

  test("the function form carries gitCredentials", () => {
    expect(
      compileRepo(() => Repo.readOnly({ gitCredentials: "none" }), undefined),
    ).toEqual({ mode: "readOnly", gitCredentials: "none" });
  });

  test("defineStep emits gitCredentials on the wire repo", () => {
    const spec = defineStep({
      key: "fetch-private",
      name: "Fetch private",
      agentPrompt: "Fetch.",
      environment: {
        runtime: Runtime.devcontainer(),
        repo: Repo.readOnly({ gitCredentials: "none" }),
      },
    });
    expect(spec.repo).toEqual({ mode: "readOnly", gitCredentials: "none" });
  });
});

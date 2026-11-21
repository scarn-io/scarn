import { describe, expect, test } from "bun:test";
import { CliError } from "../src/lib/cli-error";
import {
  confirmQuestion,
  runLoopbackSignIn,
  sharedAuthorityDisclosure,
} from "../src/lib/connections-loopback";
import {
  baseInput,
  candidateConnection,
  CODE,
  fakeApi,
  ports,
  PROJECT_ID,
  PROJECT_REF,
  redirectingBrowser,
  rejectionOf,
  SECRET,
} from "./connections-loopback-support";
import { createReporterRecorder, reportedMessages } from "./utils";

/**
 * The loopback sign-in flow with a fake API and a fake browser that "signs
 * in" by GETting the redirect on the real listener. Pins what reaches the API,
 * what the user sees, and that the secret and code are never printed.
 */

describe("runLoopbackSignIn", () => {
  test("starts on a dynamic 127.0.0.1 port, completes, shows the identity and confirms", async () => {
    const { api, calls } = fakeApi();
    const { reporter, calls: reported } = createReporterRecorder();
    const questions: string[] = [];

    const outcome = await runLoopbackSignIn({
      ...baseInput,
      reporter,
      ports: ports(api, {
        prompt: (message) => {
          questions.push(message);
          return Promise.resolve(true);
        },
      }),
    });

    expect(outcome.kind).toBe("confirmed");
    const started = calls["startLoopback"]?.[0] as { redirectUri: string };
    expect(started.redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/u,
    );
    expect(calls["complete"]).toEqual([
      {
        attemptId: "attempt-1",
        completionSecret: SECRET,
        state: "the-state",
        code: CODE,
      },
    ]);
    expect(calls["confirm"]).toEqual([
      {
        projectId: PROJECT_ID,
        connectionId: "conn-1",
        candidateId: "cand-1",
        fingerprint: "fp-1",
        expectedVersion: 3,
      },
    ]);
    expect(questions).toEqual([confirmQuestion(PROJECT_REF)]);
    expect(questions[0]).toBe(
      "Make this connection available to every step in acme/web?",
    );
    const messages = reportedMessages(reported);
    expect(messages).toContain("Connected as Ada in Acme");
    expect(messages).toContain(sharedAuthorityDisclosure("Notion"));
    expect(messages.join("\n")).not.toContain(SECRET);
    expect(messages.join("\n")).not.toContain(CODE);
  });

  test("forwards a provider error with its iss", async () => {
    const { api, calls } = fakeApi();
    const { reporter } = createReporterRecorder();
    await runLoopbackSignIn({
      ...baseInput,
      yes: true,
      reporter,
      ports: ports(api, {
        openBrowser: redirectingBrowser(
          "error=access_denied&state=the-state&iss=https%3A%2F%2Fprovider.test",
        ),
      }),
    });
    expect(calls["complete"]?.[0]).toEqual({
      attemptId: "attempt-1",
      completionSecret: SECRET,
      state: "the-state",
      error: "access_denied",
      iss: "https://provider.test",
    });
  });

  test("declining cancels the candidate", async () => {
    const { api, calls } = fakeApi();
    const { reporter } = createReporterRecorder();
    const outcome = await runLoopbackSignIn({
      ...baseInput,
      reporter,
      ports: ports(api, { prompt: () => Promise.resolve(false) }),
    });
    expect(outcome.kind).toBe("declined");
    expect(calls["cancel"]).toEqual([
      { projectId: PROJECT_ID, connectionId: "conn-1", candidateId: "cand-1" },
    ]);
    expect(calls["confirm"]).toBeUndefined();
  });

  test("--yes skips the prompt; an unverified account is called out", async () => {
    const pending = candidateConnection();
    const { api, calls } = fakeApi({
      ...pending,
      candidate: pending.candidate && {
        ...pending.candidate,
        account: {
          userName: null,
          workspaceName: null,
          identityVerified: false,
        },
      },
    });
    const { reporter, calls: reported } = createReporterRecorder();
    await runLoopbackSignIn({
      ...baseInput,
      yes: true,
      reporter,
      ports: ports(api, {
        isTty: false,
        prompt: () => Promise.reject(new Error("should not prompt")),
      }),
    });
    expect(calls["confirm"]).toHaveLength(1);
    expect(reportedMessages(reported)).toContain(
      "Notion didn't fully identify this account, so Scarn can't verify which account it is.",
    );
  });

  test("off a TTY without --yes it fails before starting anything", async () => {
    const { api, calls } = fakeApi();
    const { reporter } = createReporterRecorder();
    const error = await rejectionOf(
      runLoopbackSignIn({
        ...baseInput,
        reporter,
        ports: ports(api, { isTty: false }),
      }),
    );
    expect(error).toMatchObject({ code: "confirmation_required" });
    expect(calls["startLoopback"]).toBeUndefined();
  });

  test("--no-browser prints the URL instead of opening a browser", async () => {
    const { api } = fakeApi();
    const { reporter, calls: reported } = createReporterRecorder();
    let opened = false;
    let printed = "";
    const recorderInfo = reporter.info.bind(reporter);
    reporter.info = (message: string) => {
      recorderInfo(message);
      const match = /(https:\/\/provider\.test\S+)/u.exec(message);
      if (match?.[1] !== undefined) {
        printed = match[1];
        void redirectingBrowser(`code=${CODE}&state=the-state`)(printed);
      }
    };
    await runLoopbackSignIn({
      ...baseInput,
      yes: true,
      noBrowser: true,
      reporter,
      ports: ports(api, {
        openBrowser: () => {
          opened = true;
          return Promise.resolve();
        },
      }),
    });
    expect(opened).toBe(false);
    expect(printed).toContain("https://provider.test/authorize");
    expect(reportedMessages(reported).join("\n")).not.toContain(SECRET);
  });

  test("a reconnect uses the reconnect route", async () => {
    const { api, calls } = fakeApi();
    const { reporter } = createReporterRecorder();
    await runLoopbackSignIn({
      ...baseInput,
      target: {
        kind: "reconnect",
        connectionId: "conn-1",
        suppliedRedirectUri: null,
      },
      yes: true,
      reporter,
      ports: ports(api),
    });
    expect(calls["reconnectLoopback"]).toHaveLength(1);
    expect(calls["startLoopback"]).toBeUndefined();
  });

  test("an abort while waiting rejects and completes nothing", async () => {
    const { api, calls } = fakeApi();
    const { reporter } = createReporterRecorder();
    const controller = new AbortController();
    const signingIn = runLoopbackSignIn({
      ...baseInput,
      yes: true,
      reporter,
      signal: controller.signal,
      ports: ports(api, {
        openBrowser: () => {
          controller.abort();
          return Promise.resolve();
        },
      }),
    });
    const error = await rejectionOf(signingIn);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "loopback_cancelled" });
    expect(calls["complete"]).toBeUndefined();
  });
});

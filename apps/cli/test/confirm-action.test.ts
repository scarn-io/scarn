import { describe, expect, test } from "bun:test";
import { CliError } from "../src/lib/cli-error";
import { confirmAction } from "../src/lib/confirm-action";

function recordingPrompt(answer: boolean): {
  prompt: (message: string) => Promise<boolean>;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    prompt: (message) => {
      asked.push(message);
      return Promise.resolve(answer);
    },
  };
}

describe("confirmAction", () => {
  test("--yes proceeds without prompting, on or off a TTY", async () => {
    for (const isTty of [true, false]) {
      const { prompt, asked } = recordingPrompt(false);
      expect(
        await confirmAction({ message: "Cancel?", yes: true, isTty, prompt }),
      ).toBe(true);
      expect(asked).toEqual([]);
    }
  });

  test("on a TTY, the prompt's answer decides", async () => {
    for (const answer of [true, false]) {
      const { prompt, asked } = recordingPrompt(answer);
      expect(
        await confirmAction({
          message: "Cancel?",
          yes: false,
          isTty: true,
          prompt,
        }),
      ).toBe(answer);
      expect(asked).toEqual(["Cancel?"]);
    }
  });

  test("off a TTY without --yes, fails with confirmation_required and never prompts", async () => {
    const { prompt, asked } = recordingPrompt(true);
    let error: Error | undefined;
    try {
      await confirmAction({
        message: "Cancel execution abc?",
        yes: false,
        isTty: false,
        prompt,
      });
    } catch (caught) {
      error = caught as Error;
    }

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("confirmation_required");
    expect((error as CliError).message).toContain("--yes");
    expect(asked).toEqual([]);
  });
});

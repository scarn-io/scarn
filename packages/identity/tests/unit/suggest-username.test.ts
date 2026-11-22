import { describe, expect, test } from "bun:test";
import {
  normalizeUsernameCandidate,
  usernameSuggestionCandidates,
} from "@/authentication/domain/suggest-username";

describe("normalizeUsernameCandidate", () => {
  test.concurrent.each([
    ["octocat", "octocat"],
    ["Octo-Cat", "octo-cat"],
    ["Ada Lovelace", "ada-lovelace"],
    ["José  Núñez", "jose-nunez"],
    ["first.last_name", "first-last-name"],
    ["--edge--", "edge"],
    ["a".repeat(40), "a".repeat(32)],
    [`${"a".repeat(31)}-b`, "a".repeat(31)],
  ])("%p becomes %p", (raw, expected) => {
    expect(normalizeUsernameCandidate(raw)).toBe(expected);
  });

  test.concurrent.each([["ab"], ["!!!"], ["admin"], [""]])(
    "%p is rejected",
    (raw) => {
      expect(normalizeUsernameCandidate(raw)).toBeNull();
    },
  );
});

describe("usernameSuggestionCandidates", () => {
  test.concurrent(
    "orders github login, then name, then email local part",
    () => {
      expect(
        usernameSuggestionCandidates({
          githubLogin: "OctoCat",
          name: "Mona Lisa",
          email: "mona.l@example.com",
        }),
      ).toEqual(["octocat", "mona-lisa", "mona-l"]);
    },
  );

  test.concurrent("drops invalid and duplicate candidates", () => {
    expect(
      usernameSuggestionCandidates({
        githubLogin: null,
        name: "Admin",
        email: "admin@example.com",
      }),
    ).toEqual([]);
    expect(
      usernameSuggestionCandidates({
        name: "Mona",
        email: "mona@example.com",
      }),
    ).toEqual(["mona"]);
  });
});

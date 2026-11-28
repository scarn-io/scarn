import { describe, expect, test } from "bun:test";
import { parseContentRequestPath } from "@/tasks/artifact-share/domain/content-request-path";

describe("parseContentRequestPath", () => {
  test("a bare share or preview URL targets the entry page", () => {
    expect(parseContentRequestPath("/s/tok.mac/")).toEqual({
      kind: "file",
      via: "share",
      token: "tok.mac",
      path: null,
    });
    expect(parseContentRequestPath("/p/pv1.a.b/")).toEqual({
      kind: "file",
      via: "preview",
      token: "pv1.a.b",
      path: null,
    });
  });

  test("a missing trailing slash redirects", () => {
    expect(parseContentRequestPath("/s/tok")).toEqual({
      kind: "redirect",
      location: "/s/tok/",
    });
  });

  test("decodes each segment once", () => {
    expect(parseContentRequestPath("/s/t/docs/a%20b/%2541.txt")).toEqual({
      kind: "file",
      via: "share",
      token: "t",
      path: "docs/a b/%41.txt",
    });
  });

  test.each([
    "/",
    "/x/t/",
    "/s//",
    "/s/t%2F/",
    "/s/t/a/../b",
    "/s/t/a/%2e%2e/b",
    "/s/t/./b",
    "/s/t/a%2Fb",
    "/s/t/a%5Cb",
    "/s/t/a\\b",
    "/s/t/a%00",
    "/s/t/%zz",
    "/s/t/a//b",
    "/s/t/dir/",
  ])("refuses %s", (path) => {
    expect(parseContentRequestPath(path)).toEqual({ kind: "not_found" });
  });
});

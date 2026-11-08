import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The single ref the stub advertises; `git ls-remote` prints it on success. */
export const STUB_GIT_REF_SHA = "0123456789abcdef0123456789abcdef01234567";

export type StubGitAuthAttempt = {
  path: string;
  /** `missing`, `accepted`, or `rejected`; the credential itself is never kept. */
  outcome: "missing" | "accepted" | "rejected";
};

/**
 * A minimal HTTPS "smart HTTP" git server for `git ls-remote`: every
 * `info/refs?service=git-upload-pack` request without the expected Basic
 * credential gets a 401 challenge, so git asks its credential helper, and
 * one carrying it gets a protocol v0 ref advertisement of {@link STUB_GIT_REF_SHA}.
 * The certificate is self-signed (generated with `openssl`), so clients must
 * skip verification.
 */
export class StubHttpsGitServer {
  readonly authAttempts: StubGitAuthAttempt[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private certDir: string | null = null;

  constructor(
    private readonly expected: { username: string; password: string },
  ) {}

  async start(hostname: string): Promise<number> {
    this.certDir = await mkdtemp(path.join(os.tmpdir(), "scarn-git-stub-tls-"));
    const keyPath = path.join(this.certDir, "key.pem");
    const certPath = path.join(this.certDir, "cert.pem");
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=host.docker.internal",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ]);
    const expectedAuthorization = `Basic ${Buffer.from(
      `${this.expected.username}:${this.expected.password}`,
    ).toString("base64")}`;
    this.server = Bun.serve({
      hostname,
      port: 0,
      tls: {
        key: await readFile(keyPath, "utf8"),
        cert: await readFile(certPath, "utf8"),
      },
      fetch: (request) => {
        const url = new URL(request.url);
        const authorization = request.headers.get("authorization");
        const outcome =
          authorization === null
            ? "missing"
            : authorization === expectedAuthorization
              ? "accepted"
              : "rejected";
        this.authAttempts.push({ path: url.pathname, outcome });
        if (outcome !== "accepted") {
          return new Response("authentication required\n", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="stub"' },
          });
        }
        if (
          !url.pathname.endsWith("/info/refs") ||
          url.searchParams.get("service") !== "git-upload-pack"
        ) {
          return new Response("not found\n", { status: 404 });
        }
        return new Response(uploadPackAdvertisement(), {
          headers: {
            "Content-Type": "application/x-git-upload-pack-advertisement",
            "Cache-Control": "no-cache",
          },
        });
      },
    });
    const port = this.server.port;
    if (port === undefined) {
      throw new Error("stub git server did not bind a port");
    }
    return port;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = null;
    if (this.certDir !== null) {
      await rm(this.certDir, { recursive: true, force: true });
      this.certDir = null;
    }
  }
}

function pktLine(payload: string): string {
  return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

function uploadPackAdvertisement(): string {
  return [
    pktLine("# service=git-upload-pack\n"),
    "0000",
    pktLine(`${STUB_GIT_REF_SHA} HEAD\0symref=HEAD:refs/heads/main\n`),
    pktLine(`${STUB_GIT_REF_SHA} refs/heads/main\n`),
    "0000",
  ].join("");
}

import { cimdDocumentAllows, redirectAllowed } from "./fake-mcp-http";
import type { FakeMcpRegistrations } from "./fake-mcp-registration";

export type FakeMcpClientMode = "cimd" | "dcr" | "supplied";

/**
 * Which clients the fake OAuth server accepts and where they may redirect:
 * any CIMD document that allows the redirect, the clients `/register` issued,
 * or only the one pre-registered supplied client and its exact redirect.
 */
export class FakeMcpClients {
  readonly mode: FakeMcpClientMode;
  private readonly options: {
    registrations: FakeMcpRegistrations;
    fetchClientMetadata: (url: string) => Promise<Response>;
    strictRedirects: boolean;
    suppliedClient: { clientId: string; redirectUri: string } | null;
  };

  constructor(mode: FakeMcpClientMode, options: FakeMcpClients["options"]) {
    this.mode = mode;
    this.options = options;
  }

  /** Whether `clientId` allows `redirectUri` at `/authorize`. */
  async allows(clientId: string, redirectUri: string): Promise<boolean> {
    const { registrations, fetchClientMetadata, strictRedirects } =
      this.options;
    switch (this.mode) {
      case "cimd":
        return await cimdDocumentAllows(
          fetchClientMetadata,
          clientId,
          redirectUri,
          strictRedirects,
        );
      case "dcr":
        return redirectAllowed(
          registrations.redirectUrisOf(clientId),
          redirectUri,
          strictRedirects,
        );
      case "supplied":
        return (
          this.knows(clientId) &&
          redirectUri === this.options.suppliedClient?.redirectUri
        );
    }
  }

  /**
   * Whether `/token` accepts `clientId`: any with CIMD, one `/register`
   * issued and hasn't forgotten with DCR, or the supplied client.
   */
  knows(clientId: string | undefined): boolean {
    switch (this.mode) {
      case "cimd":
        return true;
      case "dcr":
        return this.options.registrations.knows(clientId);
      case "supplied":
        return clientId === this.options.suppliedClient?.clientId;
    }
  }
}

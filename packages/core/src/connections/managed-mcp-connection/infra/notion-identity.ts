import { z } from "zod";
import type { ManagedGrantIdentity } from "../application/managed-grant-crypto";

/** Notion's identity fields on its OAuth token response (`workspace_*`, `owner.user`); other fields are ignored. */
const notionIdentitySchema = z.object({
  workspace_id: z.string().nullish(),
  workspace_name: z.string().nullish(),
  owner: z
    .object({
      user: z
        .object({ id: z.string().nullish(), name: z.string().nullish() })
        .nullish(),
    })
    .nullish(),
});

const nonEmpty = (value: string | null | undefined): string | null =>
  value?.trim() ? value : null;

/**
 * Who signed in, read from Notion's raw token response. Fields Notion didn't
 * send are null; null overall when the identity fields are malformed.
 */
export function parseNotionIdentity(
  // eslint-disable-next-line local/no-unknown-parameter-type -- parses the raw token response
  tokenJson: unknown,
): ManagedGrantIdentity | null {
  const parsed = notionIdentitySchema.safeParse(tokenJson);
  if (!parsed.success) {
    return null;
  }
  const token = parsed.data;
  return {
    userId: nonEmpty(token.owner?.user?.id),
    userName: nonEmpty(token.owner?.user?.name),
    workspaceId: nonEmpty(token.workspace_id),
    workspaceName: nonEmpty(token.workspace_name),
  };
}

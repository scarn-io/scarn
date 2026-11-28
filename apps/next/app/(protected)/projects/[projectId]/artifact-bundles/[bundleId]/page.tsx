import { notFound } from "next/navigation";
import { Box } from "@mui/material";
import {
  parseUuidV7,
  projectArtifactBundleDetailSchema,
  type UuidV7,
} from "@scarn/api/frontend-contracts";
import {
  getScarnApiClient,
  getScarnApiRequestHeaders,
} from "@/app/_lib/scarn-api-client";
import { ArtifactBundlePageClient } from "@/components/artifacts/artifact-bundle-page-client";
import { CONTENT_MAX_WIDTH } from "@/components/theme-provider";

const tryParseUuidV7 = (value: string): UuidV7 | null => {
  try {
    return parseUuidV7(value);
  } catch {
    return null;
  }
};

/**
 * The bundle page: a bundle's files, a sandboxed preview from the content
 * origin, and its share link. Sign-in comes from the `(protected)` layout;
 * project access is checked by the API, and any miss (not a member, wrong
 * project, unknown id) is a 404.
 */
export default async function ArtifactBundlePage({
  params,
}: {
  params: Promise<{ projectId: string; bundleId: string }>;
}) {
  const ids = await params;
  const projectId = tryParseUuidV7(ids.projectId);
  const bundleId = tryParseUuidV7(ids.bundleId);
  if (!projectId || !bundleId) notFound();

  const client = await getScarnApiClient();
  const headers = await getScarnApiRequestHeaders();
  const [bundleResult, projectResult] = await Promise.all([
    client.api
      .projects({ projectId })
      ["artifact-bundles"]({ bundleId })
      .get({ headers }),
    client.api.projects({ projectId }).get({ headers }),
  ]);

  const bundle = projectArtifactBundleDetailSchema.safeParse(bundleResult.data);
  if (bundleResult.error || !bundle.success || !projectResult.data) {
    notFound();
  }

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      <Box
        sx={{
          maxWidth: CONTENT_MAX_WIDTH,
          mx: "auto",
          width: "100%",
          px: { xs: 2, md: 4 },
          py: 3,
        }}
      >
        <ArtifactBundlePageClient
          bundle={bundle.data}
          project={{ name: projectResult.data.name }}
        />
      </Box>
    </Box>
  );
}

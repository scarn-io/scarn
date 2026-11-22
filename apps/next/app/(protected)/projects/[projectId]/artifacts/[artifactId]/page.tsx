import { notFound } from "next/navigation";
import { Box } from "@mui/material";
import {
  parseUuidV7,
  projectArtifactDetailSchema,
  type UuidV7,
} from "@scarn/api/frontend-contracts";
import {
  getScarnApiClient,
  getScarnApiRequestHeaders,
} from "@/app/_lib/scarn-api-client";
import { ArtifactPageClient } from "@/components/artifacts/artifact-page-client";
import { CONTENT_MAX_WIDTH } from "@/components/theme-provider";

const tryParseUuidV7 = (value: string): UuidV7 | null => {
  try {
    return parseUuidV7(value);
  } catch {
    return null;
  }
};

/**
 * The durable artifact page that every posted comment's artifact link points
 * at. Sign-in comes from the `(protected)` layout; project access is checked
 * by the API, and any miss (not a member, wrong project, unknown id) is a 404.
 */
export default async function ArtifactPage({
  params,
}: {
  params: Promise<{ projectId: string; artifactId: string }>;
}) {
  const ids = await params;
  const projectId = tryParseUuidV7(ids.projectId);
  const artifactId = tryParseUuidV7(ids.artifactId);
  if (!projectId || !artifactId) notFound();

  const client = await getScarnApiClient();
  const headers = await getScarnApiRequestHeaders();
  const [artifactResult, projectResult] = await Promise.all([
    client.api
      .projects({ projectId })
      .artifacts({ artifactId })
      .get({ headers }),
    client.api.projects({ projectId }).get({ headers }),
  ]);

  const artifact = projectArtifactDetailSchema.safeParse(artifactResult.data);
  if (artifactResult.error || !artifact.success || !projectResult.data) {
    notFound();
  }

  const project = projectResult.data;

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
        <ArtifactPageClient
          artifact={artifact.data}
          project={{
            name: project.name,
            ownerUsername: project.ownerUsername,
            slug: project.slug,
          }}
        />
      </Box>
    </Box>
  );
}

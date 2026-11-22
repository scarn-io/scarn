import { Box } from "@mui/material";
import { CONTENT_MAX_WIDTH } from "@/components/theme-provider";

export default function OrganizationContentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
        {children}
      </Box>
    </Box>
  );
}

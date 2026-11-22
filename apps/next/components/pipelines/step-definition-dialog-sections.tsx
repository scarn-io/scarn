import { Divider, Link, Typography } from "@mui/material";

export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Divider />
      <Typography
        variant="subtitle2"
        color="text.secondary"
        sx={{ textTransform: "uppercase", letterSpacing: 0.5 }}
      >
        {children}
      </Typography>
    </>
  );
}

export function SchemaHelperText() {
  return (
    <>
      Use{" "}
      <Link
        href="https://json.ophir.dev/"
        target="_blank"
        rel="noopener noreferrer"
      >
        json.ophir.dev
      </Link>{" "}
      to create JSON type definitions. Leave blank for an empty object schema.
    </>
  );
}

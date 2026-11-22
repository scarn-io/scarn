import type { Metadata } from "next";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v16-appRouter";
import { AnalyticsProvider } from "@/components/analytics-provider";
import { AppThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "scarn",
  description: "Ticket backlog ingestion, search, and dashboard insights",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <AnalyticsProvider>
          <AppRouterCacheProvider>
            <AppThemeProvider>{children}</AppThemeProvider>
          </AppRouterCacheProvider>
        </AnalyticsProvider>
      </body>
    </html>
  );
}

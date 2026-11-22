"use client";

import { useEffect } from "react";
import { captureException } from "@scarn/observability/analytics/browser";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { digest: error.digest, scope: "global" });
  }, [error]);

  // Standalone fallback — renders when the root layout itself has thrown,
  // so we can't rely on globals.css / MUI / CSS variables being available.
  // Token hex values are intentionally inlined to keep the file self-contained.
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#07090c" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            fontFamily: "system-ui, sans-serif",
            color: "#e6edf3",
            gap: 16,
            padding: 24,
          }}
        >
          <h1 style={{ fontSize: 20, margin: 0 }}>Something went wrong</h1>
          <p style={{ margin: 0, color: "#8b949e" }}>
            We've been notified and will look into it.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #1f2630",
              background: "#11161d",
              color: "#e6edf3",
              cursor: "pointer",
              fontFamily: "inherit",
              fontWeight: 600,
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}

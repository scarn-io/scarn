"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import * as analytics from "@scarn/observability/analytics/browser";

function initAnalytics() {
  const key = process.env["NEXT_PUBLIC_POSTHOG_KEY"];
  const host = process.env["NEXT_PUBLIC_POSTHOG_HOST"];
  const uiHost = process.env["NEXT_PUBLIC_POSTHOG_UI_HOST"];
  const cookieDomain = process.env["NEXT_PUBLIC_ANALYTICS_COOKIE_DOMAIN"];
  if (!key || !host) return;
  analytics.init({ key, host, uiHost, cookieDomain });
}

function PageViewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    initAnalytics();
    if (!pathname) return;
    const query = searchParams.toString();
    const url = query ? `${pathname}?${query}` : pathname;
    analytics.pageView(`${window.location.origin}${url}`);
  }, [pathname, searchParams]);

  return null;
}

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <PageViewTracker />
      </Suspense>
      {children}
    </>
  );
}

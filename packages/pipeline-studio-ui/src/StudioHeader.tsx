import type { ReactNode } from "react";
import { TEMPLATES_PATH, type Route } from "./router";
import { Link } from "./router-react";
import type { StudioTheme } from "./theme";

/**
 * The header every screen shares: the Pipelines | Templates tabs, whatever
 * controls the screen adds (the pipeline picker), and the theme toggle.
 */
export function StudioHeader({
  route,
  theme,
  onToggleTheme,
  children,
}: {
  route: Route;
  theme: StudioTheme;
  onToggleTheme: () => void;
  children?: ReactNode;
}) {
  const onTemplates = route.name === "templates" || route.name === "template";
  const onPipelines = route.name === "pipelines";
  return (
    <header className="studio-header">
      <div className="studio-header-start">
        <nav className="studio-tabs" aria-label="Studio sections">
          <Link
            href="/"
            className="studio-tab"
            aria-current={onPipelines ? "page" : undefined}
          >
            Pipelines
          </Link>
          <Link
            href={TEMPLATES_PATH}
            className="studio-tab"
            aria-current={onTemplates ? "page" : undefined}
          >
            Templates
          </Link>
        </nav>
        {children}
      </div>
      <button
        type="button"
        className="studio-theme-toggle"
        onClick={onToggleTheme}
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      >
        {theme === "dark" ? "Light mode" : "Dark mode"}
      </button>
    </header>
  );
}

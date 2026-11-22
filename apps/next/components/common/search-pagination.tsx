import { Stack, Typography } from "@mui/material";
import Link from "next/link";
import type { CSSProperties } from "react";

export function SearchPagination({
  page,
  pageSize,
  total,
  buildHref,
}: {
  page: number;
  pageSize: number;
  total: number;
  buildHref: (nextPage: number) => string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visiblePages = buildVisiblePages(currentPage, pageCount);

  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      spacing={2}
      alignItems={{ xs: "flex-start", sm: "center" }}
      justifyContent="space-between"
      sx={{ mt: 3 }}
    >
      <Typography variant="body2" color="text.secondary">
        Showing page {page} of {pageCount} ({total} total items)
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <PaginationLink
          href={buildHref(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
        >
          Previous
        </PaginationLink>
        {visiblePages.map((item, index) =>
          item === "ellipsis" ? (
            <Typography key={`ellipsis-${String(index)}`} variant="body2" color="text.secondary" sx={{ px: 1 }}>
              ...
            </Typography>
          ) : (
            <PaginationLink
              key={item}
              href={buildHref(item)}
              selected={item === currentPage}
            >
              {item}
            </PaginationLink>
          ),
        )}
        <PaginationLink
          href={buildHref(Math.min(pageCount, currentPage + 1))}
          disabled={currentPage >= pageCount}
        >
          Next
        </PaginationLink>
      </Stack>
    </Stack>
  );
}

function PaginationLink({
  href,
  selected = false,
  disabled = false,
  children,
}: {
  href: string;
  selected?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const sx = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "40px",
    height: "36px",
    padding: "0 12px",
    borderRadius: "999px",
    border: `1px solid ${selected ? "var(--color-accent)" : "var(--color-border)"}`,
    backgroundColor: selected
      ? "color-mix(in srgb, var(--color-accent) 16%, transparent)"
      : "transparent",
    color: disabled
      ? "color-mix(in srgb, var(--color-text) 38%, transparent)"
      : selected
        ? "var(--color-accent)"
        : "var(--color-text)",
    pointerEvents: disabled ? "none" : "auto",
    opacity: disabled ? 0.45 : 1,
    textDecoration: "none",
    fontSize: "0.875rem",
    fontWeight: selected ? 700 : 500,
  } satisfies CSSProperties;

  if (disabled) {
    return <span style={sx}>{children}</span>;
  }

  return (
    <Link href={href} style={sx}>
      {children}
    </Link>
  );
}

function buildVisiblePages(currentPage: number, pageCount: number) {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, pageCount, currentPage - 1, currentPage, currentPage + 1]);
  const sortedPages = [...pages]
    .filter((value) => value >= 1 && value <= pageCount)
    .sort((left, right) => left - right);

  const items: Array<number | "ellipsis"> = [];

  for (const value of sortedPages) {
    const previous = items[items.length - 1];
    if (typeof previous === "number" && value - previous > 1) {
      items.push("ellipsis");
    }
    items.push(value);
  }

  return items;
}

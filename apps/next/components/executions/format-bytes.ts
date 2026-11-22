const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const KIB = 1024;

/**
 * Formats a byte count as a compact human-readable string using binary units
 * (KiB/MiB/GiB). Mirrors the convention used by the organization usage panel.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GiB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  if (bytes >= KIB) return `${(bytes / KIB).toFixed(1)} KiB`;
  return `${bytes.toLocaleString()} B`;
}

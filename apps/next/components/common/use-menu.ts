"use client";

import { useCallback, useState, type MouseEvent } from "react";

export type MenuController = {
  /** Anchor element the menu is positioned against, or null when closed. */
  anchorEl: HTMLElement | null;
  /** Whether the menu is currently open. */
  open: boolean;
  /** Opens the menu, anchored to the clicked element. */
  onOpen: (event: MouseEvent<HTMLElement>) => void;
  /** Closes the menu. */
  onClose: () => void;
};

/**
 * Encapsulates the `anchorEl` state boilerplate shared by every MUI `Menu`
 * trigger so components don't repeat the same `useState`/handlers.
 */
export function useMenu(): MenuController {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const onOpen = useCallback((event: MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  }, []);

  const onClose = useCallback(() => {
    setAnchorEl(null);
  }, []);

  return { anchorEl, open: anchorEl !== null, onOpen, onClose };
}

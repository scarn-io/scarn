"use client";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * Holds the dynamic breadcrumb context surfaced in the global navbar:
 * - `title`: the trailing breadcrumb segment (e.g. the current project name).
 * - `orgId`: the organization that owns the current context, used to link the
 *   middle (owner) breadcrumb segment to its org settings page.
 * - `ownerUsername`: the username of the project OWNER (not the viewer), shown
 *   as the middle breadcrumb segment. Correct for shared projects owned by a
 *   different user; replaces the old email-local-part display (PII).
 *
 * All are set by the deepest layout/component that knows them (e.g. the project
 * tabs bar, which loads the project carrying `orgId` + owner username) and
 * cleared on unmount.
 */
const AppShellContext = createContext<{
  title: string | null;
  setTitle: (t: string | null) => void;
  orgId: string | null;
  setOrgId: (id: string | null) => void;
  ownerUsername: string | null;
  setOwnerUsername: (username: string | null) => void;
}>({
  title: null,
  setTitle: () => {},
  orgId: null,
  setOrgId: () => {},
  ownerUsername: null,
  setOwnerUsername: () => {},
});

export function AppShellProvider({ children }: { children: React.ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [ownerUsername, setOwnerUsername] = useState<string | null>(null);
  return (
    <AppShellContext.Provider
      value={{
        title,
        setTitle,
        orgId,
        setOrgId,
        ownerUsername,
        setOwnerUsername,
      }}
    >
      {children}
    </AppShellContext.Provider>
  );
}

export function useAppShellTitle() {
  return useContext(AppShellContext).title;
}

export function useAppShellOrgId() {
  return useContext(AppShellContext).orgId;
}

export function useAppShellOwnerUsername() {
  return useContext(AppShellContext).ownerUsername;
}

export function useSetAppShellTitle(title: string | null) {
  const { setTitle } = useContext(AppShellContext);
  useEffect(() => {
    setTitle(title);
    return () => { setTitle(null); };
  }, [title, setTitle]);
}

export function useSetAppShellOrgId(orgId: string | null) {
  const { setOrgId } = useContext(AppShellContext);
  useEffect(() => {
    setOrgId(orgId);
    return () => { setOrgId(null); };
  }, [orgId, setOrgId]);
}

export function useSetAppShellOwnerUsername(ownerUsername: string | null) {
  const { setOwnerUsername } = useContext(AppShellContext);
  useEffect(() => {
    setOwnerUsername(ownerUsername);
    return () => { setOwnerUsername(null); };
  }, [ownerUsername, setOwnerUsername]);
}

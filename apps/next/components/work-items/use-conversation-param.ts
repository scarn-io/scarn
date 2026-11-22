"use client";

import { useCallback, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export const CONVERSATION_PARAM = "conversation";

/**
 * The open conversation sheet, held in `?conversation=<id>`. `open` pushes a
 * history entry, so back closes the sheet. `close` pops the entry it pushed;
 * when the page was loaded with the param (a deep link) there is nothing of
 * ours to pop, so it replaces the URL without it and back still stays in
 * the app.
 */
export function useConversationParam(): {
  conversationId: string | null;
  open: (conversationId: string) => void;
  close: () => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const conversationId = searchParams.get(CONVERSATION_PARAM) || null;
  const pushedRef = useRef(false);

  const hrefWith = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id === null) params.delete(CONVERSATION_PARAM);
      else params.set(CONVERSATION_PARAM, id);
      const query = params.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [pathname, searchParams],
  );

  const open = useCallback(
    (id: string) => {
      if (id === conversationId) return;
      if (conversationId !== null) {
        router.replace(hrefWith(id), { scroll: false });
        return;
      }
      pushedRef.current = true;
      router.push(hrefWith(id), { scroll: false });
    },
    [conversationId, hrefWith, router],
  );

  const close = useCallback(() => {
    if (conversationId === null) return;
    if (pushedRef.current) {
      pushedRef.current = false;
      router.back();
      return;
    }
    router.replace(hrefWith(null), { scroll: false });
  }, [conversationId, hrefWith, router]);

  return { conversationId, open, close };
}

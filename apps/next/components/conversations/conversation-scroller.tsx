"use client";

/**
 * The scrolling box around a conversation. It starts at the bottom, follows
 * new messages while you're within `NEAR_BOTTOM_PX` of the bottom, always
 * follows a message you send, and offers **Jump to latest** when you've
 * scrolled up. With `follow` off it is a plain scrolling box.
 */

import { Box, Fab, type BoxProps } from "@mui/material";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ConversationData } from "./use-conversation";

export const NEAR_BOTTOM_PX = 120;

const scrollToBottom = (
  element: HTMLElement | null,
  behavior: ScrollBehavior = "auto",
) => {
  if (!element) return;
  if (behavior === "smooth" && typeof element.scrollTo === "function") {
    element.scrollTo({ top: element.scrollHeight, behavior });
  } else {
    element.scrollTop = element.scrollHeight;
  }
};

export function ConversationScroller({
  data,
  follow = true,
  scrollRef,
  px,
  testId,
  children,
}: {
  data: ConversationData;
  follow?: boolean;
  /** Shares the scrolling element with the caller (keyboard navigation, scrolling to a run). */
  scrollRef?: RefObject<HTMLDivElement | null>;
  px?: BoxProps["px"];
  testId?: string;
  children: ReactNode;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = scrollRef ?? ownRef;
  const nearBottom = useRef(true);
  const seenLocal = useRef(data.localMessages.length);
  const [showJump, setShowJump] = useState(false);
  const messageCount = data.conversation?.messages.length ?? 0;
  const localCount = data.localMessages.length;
  const status = data.conversation?.status ?? null;

  useLayoutEffect(() => {
    if (!follow) return;
    const sentOne = localCount > seenLocal.current;
    seenLocal.current = localCount;
    if (sentOne) {
      nearBottom.current = true;
      setShowJump(false);
      scrollToBottom(ref.current, "smooth");
    } else if (nearBottom.current) {
      scrollToBottom(ref.current);
    }
  }, [follow, ref, messageCount, localCount, status]);

  return (
    <Box
      sx={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Box
        ref={ref}
        data-testid={testId}
        onScroll={(event) => {
          if (!follow) return;
          const element = event.currentTarget;
          const distance =
            element.scrollHeight - element.scrollTop - element.clientHeight;
          nearBottom.current = distance < NEAR_BOTTOM_PX;
          setShowJump(!nearBottom.current);
        }}
        sx={{ flex: 1, minHeight: 0, overflowY: "auto", px }}
      >
        {children}
      </Box>
      {follow && showJump ? (
        <Fab
          size="small"
          aria-label="Jump to latest"
          onClick={() => {
            scrollToBottom(ref.current, "smooth");
          }}
          sx={{
            position: "absolute",
            bottom: 12,
            left: "50%",
            transform: "translateX(-50%)",
            bgcolor: "background.paper",
            color: "text.primary",
            border: 1,
            borderColor: "divider",
            boxShadow: 3,
            "&:hover": { bgcolor: "background.paper" },
          }}
        >
          <ArrowDownwardIcon fontSize="small" />
        </Fab>
      ) : null}
    </Box>
  );
}

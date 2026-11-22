"use client";

import { useEffect, useRef, useState } from "react";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";

/**
 * Live username availability check shared by onboarding and account settings.
 *
 * `"error"` means the check itself failed (network or server error). Callers
 * should still let the user submit: `POST /username` re-validates and answers
 * 409 on a conflict.
 */
export type UsernameAvailabilityStatus =
  "idle" | "checking" | "available" | "taken" | "invalid" | "error";

export const USERNAME_AVAILABILITY_DEBOUNCE_MS = 350;

export const normalizeUsernameInput = (value: string): string =>
  value.trim().toLowerCase();

export interface UseUsernameAvailabilityOptions {
  /** A candidate that needs no check (e.g. the user's current handle). */
  ignore?: string | null;
  debounceMs?: number;
}

export function useUsernameAvailability(
  value: string,
  {
    ignore = null,
    debounceMs = USERNAME_AVAILABILITY_DEBOUNCE_MS,
  }: UseUsernameAvailabilityOptions = {},
): UsernameAvailabilityStatus {
  const [status, setStatus] = useState<UsernameAvailabilityStatus>("idle");
  const latestQueryRef = useRef<string>("");
  const initialValueRef = useRef<string | null>(normalizeUsernameInput(value));

  useEffect(() => {
    const candidate = normalizeUsernameInput(value);
    latestQueryRef.current = candidate;
    const checkImmediately = initialValueRef.current === candidate;
    initialValueRef.current = null;

    if (candidate.length === 0 || candidate === ignore) {
      setStatus("idle");
      return;
    }

    const check = () => {
      setStatus("checking");
      void getBrowserScarnApiClient()
        .api.username.available.get({ query: { u: candidate } })
        .then(({ data, error }) => {
          if (latestQueryRef.current !== candidate) return;
          if (error) {
            setStatus("error");
            return;
          }
          if (!data.valid) {
            setStatus("invalid");
            return;
          }
          setStatus(data.available ? "available" : "taken");
        })
        .catch(() => {
          if (latestQueryRef.current !== candidate) return;
          setStatus("error");
        });
    };

    if (checkImmediately) {
      check();
      return;
    }
    const handle = setTimeout(check, debounceMs);
    return () => {
      clearTimeout(handle);
    };
  }, [value, ignore, debounceMs]);

  return status;
}

export function usernameHelperText(status: UsernameAvailabilityStatus): string {
  switch (status) {
    case "checking":
      return "Checking availability…";
    case "available":
      return "This username is available.";
    case "taken":
      return "This username is already taken.";
    case "invalid":
      return "Use 3-32 lowercase letters, numbers, or single hyphens.";
    case "error":
      return "Couldn't check availability — you can still continue.";
    case "idle":
      return "Lowercase letters, numbers, and single hyphens.";
  }
}

export const isUsernameSubmittable = (
  status: UsernameAvailabilityStatus,
): boolean => status === "available" || status === "error";

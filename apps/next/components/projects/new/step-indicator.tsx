"use client";

import { Stack, Typography } from "@mui/material";
import type { WizardStep } from "./wizard-params";

const STEPS: { step: WizardStep; label: string }[] = [
  { step: "repository", label: "Repository" },
  { step: "details", label: "Details" },
  { step: "issues", label: "Issues" },
];

/** A quiet indicator for the sequential Repository → Details → Issues flow. */
export function StepIndicator({ current }: { current: WizardStep }) {
  const activeIndex = STEPS.findIndex(({ step }) => step === current);

  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ mb: 2 }}
      aria-label="Progress"
    >
      {STEPS.map(({ step, label }, index) => {
        const isActive = index <= activeIndex;
        return (
          <Stack key={step} direction="row" spacing={1} alignItems="center">
            {index > 0 ? (
              <Typography
                component="span"
                color="text.disabled"
                sx={{ fontSize: "0.75rem" }}
              >
                →
              </Typography>
            ) : null}
            <Typography
              component="span"
              aria-current={index === activeIndex ? "step" : undefined}
              sx={{
                fontSize: "0.75rem",
                fontWeight: isActive ? 600 : 400,
                color: isActive ? "text.primary" : "text.disabled",
              }}
            >
              {label}
            </Typography>
          </Stack>
        );
      })}
    </Stack>
  );
}

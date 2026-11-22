/**
 * The `/projects/new` wizard keeps its place in the address bar, so the
 * GitHub App install round-trip, the CLI hand-off and the browser's Back
 * button all land on the right step. Only the repo URL, name, description,
 * origin and step go here; tokens never do.
 */

export const WIZARD_STEPS = ["repository", "details", "issues"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export type WizardParams = {
  gitUrl: string | null;
  name: string | null;
  description: string | null;
  origin: "web" | "cli_handoff";
  step: WizardStep;
};

const isWizardStep = (value: string | null): value is WizardStep =>
  WIZARD_STEPS.some((step) => step === value);

/**
 * Reads the wizard's place from the query. A step past the repository needs
 * a `gitUrl`. The CLI hand-off (`?gitUrl=&name=&source=cli`) has no step and
 * starts on Details.
 */
export function readWizardParams(searchParams: URLSearchParams): WizardParams {
  const gitUrl = searchParams.get("gitUrl")?.trim() || null;
  const origin = searchParams.get("source") === "cli" ? "cli_handoff" : "web";
  const requested = searchParams.get("step");
  const step: WizardStep =
    gitUrl === null
      ? "repository"
      : isWizardStep(requested)
        ? requested
        : origin === "cli_handoff"
          ? "details"
          : "repository";
  return {
    gitUrl,
    name: searchParams.get("name"),
    description: searchParams.get("description"),
    origin,
    step,
  };
}

/** `/projects/new` for a step, keeping `source=cli` but dropping install flash params. */
export function wizardHref(
  params: Pick<WizardParams, "gitUrl" | "name" | "description" | "origin">,
  step: WizardStep,
): string {
  const query = new URLSearchParams();
  if (params.gitUrl) query.set("gitUrl", params.gitUrl);
  if (params.name) query.set("name", params.name);
  if (params.description) query.set("description", params.description);
  if (params.origin === "cli_handoff") query.set("source", "cli");
  query.set("step", step);
  return `/projects/new?${query.toString()}`;
}

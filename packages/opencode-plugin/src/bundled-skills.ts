import domainModelingAdrFormat from "../skills/domain-modeling/ADR-FORMAT.md" with { type: "text" };
import domainModelingContextFormat from "../skills/domain-modeling/CONTEXT-FORMAT.md" with { type: "text" };
import domainModelingSkill from "../skills/domain-modeling/SKILL.md" with { type: "text" };
import grillingSkill from "../skills/grilling/SKILL.md" with { type: "text" };

/**
 * Skills that ship with the Scarn OpenCode plugin (`skills/`), embedded as
 * text so they travel inside the compiled CLI like the plugin itself.
 *
 * The worker seeds them into the agent HOME's `~/.claude/skills`, never the
 * workspace. That is the lowest-precedence skill source in OpenCode 2.1.4, so
 * a repo's own `.opencode/skills`, `.agents/skills` or `.claude/skills` wins on
 * a name clash. A `skills` config entry would not work: explicit entries are
 * registered last and override every repo skill.
 */
export type BundledSkillFile = {
  /** Path relative to the skills root, e.g. `grilling/SKILL.md`. */
  relativePath: string;
  content: string;
};

/** Agent-HOME-relative directory the bundled skills are seeded into. */
export const BUNDLED_SKILLS_HOME_DIR = ".claude/skills";

export const BUNDLED_SKILL_FILES: readonly BundledSkillFile[] = [
  { relativePath: "grilling/SKILL.md", content: grillingSkill },
  { relativePath: "domain-modeling/SKILL.md", content: domainModelingSkill },
  {
    relativePath: "domain-modeling/ADR-FORMAT.md",
    content: domainModelingAdrFormat,
  },
  {
    relativePath: "domain-modeling/CONTEXT-FORMAT.md",
    content: domainModelingContextFormat,
  },
];

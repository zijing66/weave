/**
 * Skill effectiveness counting for the grouped global-skills view.
 *
 * A skill is "in effect" unless the plugin that ships it is disabled. The
 * distinction lives in `enabled`, which the server only sets for plugin groups:
 * personal skills have no toggle at all, so they are always in effect
 * (see `decorate` in packages/weave-server/src/install/global-config.ts).
 */

/** The shape the counter needs — structurally compatible with SkillGroup. */
export interface CountableSkillGroup {
  /** Plugin groups only; `undefined` means "no toggle, always effective". */
  enabled?: boolean;
  skills: readonly unknown[];
}

export interface SkillEffectiveness {
  /** Skills belonging to groups that are not disabled. */
  effective: number;
  /** Every skill listed, effective or not. */
  total: number;
}

export function countEffectiveSkills(groups: readonly CountableSkillGroup[]): SkillEffectiveness {
  let effective = 0;
  let total = 0;
  for (const group of groups) {
    total += group.skills.length;
    // Only an explicit `false` counts as off — `undefined` is "not applicable".
    if (group.enabled !== false) effective += group.skills.length;
  }
  return { effective, total };
}

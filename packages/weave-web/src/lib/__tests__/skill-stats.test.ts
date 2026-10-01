import { describe, it, expect } from 'vitest';
import { countEffectiveSkills } from '../skill-stats';

const skills = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ name: `s${i}` }));

describe('countEffectiveSkills', () => {
  it('counts everything when no group is disabled', () => {
    const result = countEffectiveSkills([
      { enabled: true, skills: skills(3) },
      { enabled: undefined, skills: skills(2) },
    ]);
    expect(result).toEqual({ effective: 5, total: 5 });
  });

  it('excludes the skills of a disabled plugin group', () => {
    const result = countEffectiveSkills([
      { enabled: true, skills: skills(4) },
      { enabled: false, skills: skills(6) },
    ]);
    expect(result).toEqual({ effective: 4, total: 10 });
  });

  it('treats a group with no enabled flag as always effective', () => {
    // personal skills have no toggle at all
    const result = countEffectiveSkills([{ skills: skills(7) }]);
    expect(result).toEqual({ effective: 7, total: 7 });
  });

  it('counts a disabled group in the total but not as effective', () => {
    const result = countEffectiveSkills([{ enabled: false, skills: skills(5) }]);
    expect(result).toEqual({ effective: 0, total: 5 });
  });

  it('returns zeroes for an empty selection', () => {
    expect(countEffectiveSkills([])).toEqual({ effective: 0, total: 0 });
  });

  it('handles groups with no skills', () => {
    const result = countEffectiveSkills([
      { enabled: true, skills: [] },
      { enabled: false, skills: [] },
    ]);
    expect(result).toEqual({ effective: 0, total: 0 });
  });
});

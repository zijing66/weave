# Refactoring Skill

## Purpose
Safely restructure code without changing external behavior.

## Process
1. Ensure tests exist for the target code before refactoring
2. Make one change at a time, verify tests pass after each
3. Don't mix refactoring with feature changes
4. Delete dead code rather than commenting it out
5. Prefer editing existing files over creating new ones

## Anti-patterns to avoid
- Adding abstractions "for the future" — three similar lines > premature abstraction
- Renaming unused `_vars` for backwards-compat
- Adding `// removed` comments for removed code

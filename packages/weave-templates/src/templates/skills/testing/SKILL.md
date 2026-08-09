# Testing Skill

## Purpose
Write and run tests effectively for this project.

## Guidelines
- Pure functions → unit tests (vitest, `*.test.ts`)
- Test file naming: `*.test.ts`, placed alongside source or in `__tests__/`
- Behavior verification over implementation verification
- One `describe` per function, one `it` per behavior
- Don't mock what you don't own; use real implementations or fakes

## Commands
- Run all tests: `npm test` / `pnpm test`
- Run with watch: `vitest --watch`

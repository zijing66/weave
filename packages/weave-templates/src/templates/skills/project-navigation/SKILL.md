# Project Navigation Skill

## Purpose
Efficiently locate and understand code in this project.

## Strategy
- Use Glob for filename patterns, Grep for symbol/keyword searches
- Prefer dedicated tools over Bash find/grep/rg
- When unsure about scope, use an Explore subagent
- Read files before editing — the Edit tool requires a prior Read

## Key paths
- Source code: `src/`
- Tests: `__tests__/` or `*.test.ts`
- Config files: root-level `*.json`, `*.yaml`, `*.config.*`

# Code Review Skill

## Purpose
Perform thorough, constructive code reviews following best practices.

## Process
1. Read the entire diff before forming opinions
2. Check for correctness, security, performance, and maintainability
3. Use ReportFindings tool to file verified findings (most-severe first)
4. After fixes, re-report with `outcome` set on each finding

## Guidelines
- Findings must have concrete failure scenarios: "input X → wrong output Y"
- Don't flag style issues that a formatter would catch
- One finding = one defect; don't bundle unrelated issues
- Verify before reporting — skip anything that isn't reproducible

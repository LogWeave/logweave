---
name: scope-milestone
description: Break down a milestone into GitHub Issues with acceptance criteria
disable-model-invocation: false
---

Scope out the milestone: $ARGUMENTS

1. Read @PLAN.md and find the section corresponding to this milestone
2. Break the milestone deliverables into individual GitHub Issues
3. For each issue:
   - Write a clear title (under 70 characters)
   - Write acceptance criteria with specific, testable outcomes
   - Include the test gate from PLAN.md if one exists
   - Add labels: `feature`, `test`, `infra`, or `decision`
   - Include a **Context** section with:
     - **Files**: source files/directories the implementer will need to read or modify
     - **ADRs**: any applicable architecture decision records (e.g., "see docs/adr/007-...")
     - **PLAN.md ref**: the specific section of PLAN.md to reference
     - **Constraints**: task-specific constraints beyond CLAUDE.md (e.g., "no new dependencies", "must handle <200ms", "do not modify clusterer")
   - Include a **User Story** (As a _____, I want _____, so that _____)
   - Include **Named Test Cases** — specific test names the implementer should write
4. Identify dependency order between issues and note it in each issue body
5. Create the issues with `gh issue create` and assign them to the milestone
6. List all created issues with dependency order for review

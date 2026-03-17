---
name: fix-issue
description: Fix a GitHub issue end-to-end
disable-model-invocation: false
---

Fix the GitHub issue: $ARGUMENTS

## Phase 1: Understand

1. Run `gh issue view $ARGUMENTS` to read the issue details, acceptance criteria, and context section
2. Identify which service is affected (clusterer, api, or both)
3. Search the codebase for relevant files — start with any files listed in the issue's Context section

## Phase 2: Scope Declaration

4. Before writing any code, output a **scope declaration**:
   - **Files to modify** — list every file you expect to touch
   - **Off-limits** — services/directories you will NOT touch
   - **New dependencies** — any packages you think you'll need (flag for user approval)
   - **Test surface** — which test files you'll add/modify
   - **Risk areas** — anything non-obvious that could break
5. Wait for user confirmation before proceeding

## Phase 3: Plan (non-trivial work only)

6. If the issue involves architectural decisions, new modules, or cross-cutting changes:
   - Enter plan mode and design the approach
   - Run the reviewer agent against the plan — check for ADR violations, missed edge cases, over-engineering
   - Revise plan based on review feedback
   - Commit the finalized plan as `docs/plans/LW-$ARGUMENTS.md` on the feature branch
7. If the issue is a straightforward bug fix or small change, skip this phase

## Phase 4: Implement

8. If the issue has testable acceptance criteria, write a failing test first (TDD)
9. Implement the fix
10. Run the appropriate test suite:
    - Clusterer: `cd services/clusterer && uv run poe test`
    - API: `cd services/api && pnpm test`
11. Verify all tests pass (existing + new)
12. Create a descriptive commit referencing the issue number

## Phase 5: Exit Gate

13. Walk through **every** acceptance criterion from the issue — verify each is met
14. Run the reviewer agent on the diff (background)
15. Address any CRITICAL or HIGH findings before proceeding
16. Push and create a PR with `gh pr create`

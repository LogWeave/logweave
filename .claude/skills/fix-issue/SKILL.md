---
name: fix-issue
description: Fix a GitHub issue end-to-end
disable-model-invocation: true
---

Fix the GitHub issue: $ARGUMENTS

1. Run `gh issue view $ARGUMENTS` to read the issue details and acceptance criteria
2. Identify which service is affected (clusterer, api, or both)
3. Search the codebase for relevant files
4. If the issue has testable acceptance criteria, write a failing test first
5. Implement the fix
6. Run the appropriate test suite:
   - Clusterer: `cd services/clusterer && pytest`
   - API: `cd services/api && pnpm test`
7. Verify all tests pass (existing + new)
8. Create a descriptive commit referencing the issue number
9. Push and create a PR with `gh pr create`

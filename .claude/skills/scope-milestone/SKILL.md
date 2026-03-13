---
name: scope-milestone
description: Break down a milestone into GitHub Issues with acceptance criteria
disable-model-invocation: true
---

Scope out the milestone: $ARGUMENTS

1. Read @PLAN.md and find the section corresponding to this milestone
2. Break the milestone deliverables into individual GitHub Issues
3. For each issue:
   - Write a clear title (under 70 characters)
   - Write acceptance criteria with specific, testable outcomes
   - Include the test gate from PLAN.md if one exists
   - Add labels: `feature`, `test`, `infra`, or `decision`
4. Create the issues with `gh issue create` and assign them to the milestone
5. List all created issues for review

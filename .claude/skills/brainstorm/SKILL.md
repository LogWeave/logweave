---
name: brainstorm
description: Structured Socratic brainstorming before any creative work — features, components, architecture changes, or behavior modifications. Use BEFORE planning or coding.
disable-model-invocation: false
---

Brainstorm and refine the idea: $ARGUMENTS

## Purpose

This skill runs BEFORE planning or implementation. It surfaces edge cases, design decisions,
and constraints through structured questioning — catching problems when they're cheap to fix.

## Process

### Step 1: Gather Context

- Read any referenced issues, PLAN.md sections, or ADRs relevant to the topic
- Scan the codebase for existing code that relates to this work
- Review docs/lessons-learned.md for past mistakes in this area
- Summarize what you found in 2-3 sentences — what exists, what's missing, what constraints apply

### Step 2: Ask Clarifying Questions

Ask questions using the AskUserQuestion tool. Follow these rules strictly:

- **One question per message** — never bundle multiple questions
- **Prefer multiple choice** over open-ended when possible (present 2-4 options with trade-offs)
- **Ask the hard questions first** — the ones the user probably hasn't thought about yet
- **Don't ask obvious questions** — if the answer is in the code or docs, don't waste the user's time
- **Dig into constraints** — scalability, failure modes, tenant isolation, what happens when things break
- **Challenge assumptions** — if the user's idea has a simpler alternative, propose it

Question areas to cover (skip any that are already clear from context):
1. **Scope boundaries** — what's in, what's explicitly out, what's deferred
2. **Failure modes** — what breaks, how do we degrade, what's the blast radius
3. **Integration points** — what existing code/services does this touch
4. **Data model implications** — schema changes, migrations, backwards compatibility
5. **User-facing behavior** — what does the consumer (API caller, MCP user, dashboard user) actually see
6. **Testing strategy** — what's the minimum test surface to prove this works

Stop asking when you have enough to propose approaches. This is typically 3-6 questions,
rarely more than 8. Don't over-interview.

### Step 3: Propose Approaches

Present **2-3 concrete approaches** with:
- **What it is** — one sentence
- **Trade-offs** — what you gain and what you give up
- **Complexity** — Low / Medium / High relative to this project
- **Recommendation** — which one and why

If there's clearly only one viable approach, say so and explain why alternatives don't work.
Don't invent fake alternatives for the sake of having three options.

### Step 4: Design Review

Once the user picks an approach (or you converge on one):

1. Present the design in **sections scaled to complexity**:
   - Simple change: 1 section covering the whole thing
   - Medium feature: 2-3 sections (data model, API surface, implementation)
   - Large feature: 4-5 sections (each reviewed before moving to the next)
2. Get **explicit approval** on each section before proceeding to the next
3. Apply YAGNI ruthlessly — if a detail isn't needed for MVP, cut it
4. If the design reveals multiple independent subsystems, flag immediately and propose decomposing into separate issues

### Step 5: Write Spec

Write the approved design to `docs/specs/$ARGUMENTS-design.md` with:

```markdown
# [Topic] Design Spec

**Date:** [today]
**Status:** Approved
**Issue:** [if applicable]

## Goal
[One sentence — why, not what]

## Approach
[The chosen approach with key decisions]

## Scope
- **In scope:** [bulleted list]
- **Out of scope / deferred:** [bulleted list]

## Design
[The approved design sections]

## Open Questions
[Anything unresolved — should be empty if brainstorming was thorough]

## Test Strategy
[Minimum test surface to prove this works]
```

Commit the spec file on the current branch.

### Step 6: Transition

After the spec is written and committed:
- If the user wants to proceed to implementation: transition to plan mode or `/fix-issue`
- If this was exploratory: stop here, the spec is the deliverable
- NEVER skip directly to writing code — the spec must exist before implementation begins

## Anti-Patterns to Avoid

- **"This is too simple for brainstorming"** — every change gets at least a quick pass. The design can be 3 lines, but it must exist and be approved.
- **Asking questions you can answer yourself** — read the code first. Don't ask "does X exist?" when you can grep for it.
- **Bundling questions** — one per message, always. The user needs space to think.
- **Proposing approaches before understanding the problem** — questions first, proposals second.
- **Gold-plating the spec** — match spec detail to change complexity. A config tweak doesn't need a 50-line spec.

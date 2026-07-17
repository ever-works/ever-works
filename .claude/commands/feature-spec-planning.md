---
name: feature-spec-planning
description: Workflow command scaffold for feature-spec-planning in ever-works.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-spec-planning

Use this workflow when working on **feature-spec-planning** in `ever-works`.

## Goal

Creates or updates the canonical specification, plan, and task breakdown for a new or enhanced feature.

## Common Files

- `docs/specs/features/*/spec.md`
- `docs/specs/features/*/plan.md`
- `docs/specs/features/*/tasks.md`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Create or update docs/specs/features/[feature]/spec.md
- Create or update docs/specs/features/[feature]/plan.md
- Create or update docs/specs/features/[feature]/tasks.md

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.
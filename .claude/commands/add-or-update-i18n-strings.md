---
name: add-or-update-i18n-strings
description: Workflow command scaffold for add-or-update-i18n-strings in ever-works.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-or-update-i18n-strings

Use this workflow when working on **add-or-update-i18n-strings** in `ever-works`.

## Goal

Adds or updates internationalization (i18n) strings for new features or UI changes across multiple locales.

## Common Files

- `apps/web/messages/en.json`
- `apps/web/messages/*.json`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit or add keys in apps/web/messages/en.json (source locale)
- Edit or add corresponding keys in other locale JSON files (e.g., ar.json, de.json, etc.)

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.
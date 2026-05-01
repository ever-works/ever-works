# Ever Works Platform — Specs

This directory holds **internal architectural specs and ADRs** for the Ever
Works Platform. It is _not_ user-facing documentation — those live in
[`../features/`](../features/), [`../api/`](../api/), and the rest of
[`../`](../). These specs target AI agents and humans who need to understand
how features work architecturally and reason about changes to them.

The specs follow the
[GitHub Spec Kit](https://github.com/github/spec-kit) methodology adapted
to the Ever Works monorepo. The Spec Kit infrastructure
(constitution, templates, bootstrap scripts) lives in
[`.specify/`](https://github.com/ever-works/ever-works/tree/develop/.specify)
at the monorepo root.

## Layout

```
docs/specs/
├── README.md                       # This file
├── decisions/                      # Architecture Decision Records (ADRs)
│   └── 001-pipeline-checkpointing.md
├── architecture/                   # Cross-feature architecture docs
│   ├── pipeline-overview.md
│   └── trigger-integration.md
├── ai/                             # Cross-cutting AI / generation specs
│   ├── implementation-plan.md
│   └── tasks-checklist.md
└── features/                       # Spec Kit feature directories
    ├── advanced-prompts/           # spec.md + acceptance.md
    ├── data-generator/             # spec.md + acceptance.md
    ├── markdown-generator/         # spec.md + acceptance.md
    ├── website-generator/          # spec.md + acceptance.md
    ├── works-config/               # spec.md + plan.md + tasks.md (retrospective)
    ├── scheduled-updates/          # …                            (retrospective)
    ├── comparisons/                # …                            (retrospective)
    ├── generation-cancellation/    # …                            (retrospective)
    ├── community-pr-processing/    # …                            (retrospective)
    ├── directory-import/           # …                            (retrospective)
    └── plugin-system/              # …                            (retrospective)
```

## Reading order for new contributors

1. **[Constitution](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md)** —
   the non-negotiable engineering principles every spec reconciles with
   (lives in `.specify/memory/constitution.md` at the monorepo root).
2. **Architecture overviews** —
   [pipeline overview](architecture/pipeline-overview),
   [trigger integration](architecture/trigger-integration). Read these
   before diving into a feature spec.
3. **A specific feature** under `features/` — start with `spec.md`
   (behaviour), then `plan.md` (implementation), then `tasks.md`
   (execution).
4. **ADRs in `decisions/`** — historical decisions that constrain current
   designs.

## Spec Kit workflow

Three artifacts per feature, produced sequentially:

| Step       | Produces   | What it captures                                                             |
| ---------- | ---------- | ---------------------------------------------------------------------------- |
| `/specify` | `spec.md`  | **Behaviour** — user scenarios, functional requirements, acceptance criteria |
| `/plan`    | `plan.md`  | **Implementation** — architecture, tech choices, data model, phasing         |
| `/tasks`   | `tasks.md` | **Execution** — ordered, granular tasks with explicit file paths             |

Each step is gated by the
[constitution checklist](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#compliance-checklist).
A spec that conflicts with a non-negotiable principle blocks the next step
until the conflict is resolved (either by amending the spec or by amending
the constitution via PR).

## Bootstrap a new feature

```bash
# Bash / macOS / Linux / Git Bash on Windows
./.specify/scripts/bash/create-new-feature.sh <slug> "Feature Title"

# PowerShell
./.specify/scripts/powershell/create-new-feature.ps1 -Slug <slug> -Title "Feature Title"
```

Either script creates `docs/specs/features/<slug>/{spec,plan,tasks}.md` from
the templates with the slug, title, and today's date pre-filled.

## Retrospective specs

Most existing platform features predate the Spec Kit adoption. Their specs
were authored retrospectively and are marked `Status: Retrospective` in the
frontmatter — they describe what the platform actually does today, in the
same shape as a forward-looking spec. Future changes to those features
should update the retrospective spec and follow the standard /specify →
/plan → /tasks loop.

A feature is retrospectively spec'd when:

1. The behaviour is observable in production today.
2. The implementation has been read directly from the current `develop`
   branch (no speculation).
3. Constitution gates have been audited.

Features that are still partly in flight (e.g. GitHub App onboarding, the
hermes-agent / activepieces plugins) will get specs once their behaviour
stabilises on `develop`.

## Spec Format

Each Spec Kit feature spec follows
[`.specify/templates/spec-template.md`](https://github.com/ever-works/ever-works/blob/develop/.specify/templates/spec-template.md).
Sections (in order):

1. Overview
2. User Scenarios — primary + edge cases & failures
3. Functional Requirements (numbered, atomic, testable)
4. Non-Functional Requirements (performance, reliability, security,
   observability, compatibility)
5. Key Entities & Domain Concepts
6. Out of Scope
7. Acceptance Criteria
8. Open Questions (with `[NEEDS CLARIFICATION: …]` markers)
9. Constitution Gates
10. References

Plan and tasks templates have their own sections — see the templates.

## Keeping specs honest

When changing a feature:

1. Update its `spec.md` if user-observable behaviour changes.
2. Update its `plan.md` if the implementation strategy changes.
3. Add new tasks to `tasks.md` if the work needs sub-PRs.
4. If a constitution gate now fails for a previously-compliant feature,
   file an ADR in `decisions/` explaining why and proposing the resolution
   (amend constitution, refactor feature, or accept exception).

## Related Documentation

- **User-facing docs**: [`../features/`](../features/), [`../api/`](../api/)
- **API documentation**: Generated from NestJS decorators (Swagger)
- **Plugin SDK reference**: [`../plugin-system/`](../plugin-system/)
- **Architecture overview**: [`../architecture.md`](../architecture.md)

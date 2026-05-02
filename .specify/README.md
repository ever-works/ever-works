# `.specify/` — Ever Works Spec Kit

This folder contains the Ever Works adaptation of the
[GitHub Spec Kit](https://github.com/github/spec-kit) workflow:
constitution, templates, and bootstrap scripts. The actual feature specs
live in [`docs/specs/`](../docs/specs/).

## Layout

```
.specify/
├── memory/
│   └── constitution.md          # Project principles (highest priority)
├── templates/
│   ├── spec-template.md         # Behaviour spec template
│   ├── plan-template.md         # Implementation plan template
│   └── tasks-template.md        # Task breakdown template
└── scripts/
    ├── bash/
    │   ├── create-new-feature.sh   # Scaffold a feature dir under docs/specs/features/
    │   └── check-prerequisites.sh
    └── powershell/
        ├── create-new-feature.ps1
        └── check-prerequisites.ps1
```

Where the specs go:

```
docs/specs/
├── README.md                       # Index of all specs and ADRs
├── decisions/                      # Architecture Decision Records (ADRs)
│   └── 001-pipeline-checkpointing.md
├── architecture/                   # Cross-feature architecture docs
│   ├── pipeline-overview.md
│   └── trigger-integration.md
├── ai/                             # Cross-cutting AI / generation specs
│   ├── implementation-plan.md
│   └── tasks-checklist.md
└── features/                       # Spec Kit feature directories
    └── <feature-slug>/
        ├── spec.md                 # Behaviour-first spec
        ├── plan.md                 # Implementation plan
        └── tasks.md                # Ordered task breakdown
```

## Workflow

The workflow is the standard
[Spec-Driven Development](https://github.com/github/spec-kit#spec-driven-development)
loop:

1. **`/specify`** — describe the feature behaviour. Output: `spec.md`.
2. **`/plan`** — derive an implementation plan from the spec. Output: `plan.md`.
3. **`/tasks`** — break the plan down into ordered tasks. Output: `tasks.md`.

Each step has its own template under `.specify/templates/`. Each step also
runs through the
[constitution gates](memory/constitution.md#compliance-checklist) — a spec
that conflicts with a non-negotiable principle blocks the next step.

## Bootstrapping a new feature

### Bash / Linux / macOS / Git Bash on Windows

```bash
.specify/scripts/bash/create-new-feature.sh my-feature "My Feature"
```

### PowerShell

```powershell
.\.specify\scripts\powershell\create-new-feature.ps1 -Slug my-feature -Title "My Feature"
```

Both scripts create `docs/specs/features/my-feature/{spec,plan,tasks}.md`
from the templates with placeholders pre-filled.

## Retrospective specs

Specs added for features that already shipped use the
`Status: Retrospective` value in their frontmatter. They're useful for:

- Onboarding new engineers — read the spec to learn the feature's behaviour.
- Anchoring future changes — modifications go through the same gates as
  new features.
- Detecting drift — when behaviour changes silently, the spec drifts and
  becomes a forcing function to update it.

The platform ships with retrospective specs for all major user-facing
features under `docs/specs/features/`.

## Why we use this

Per [Constitution Principle IX](memory/constitution.md#ix-specs-are-behaviour-first),
every feature in this monorepo is described **behaviour-first** before any
code is written (or, in the retrospective case, alongside the code that
already exists). The constitution captures the platform's enduring
principles; specs capture per-feature behaviour; plans capture
implementation; tasks capture execution. Each layer is reviewed
independently and forms the audit trail for everything we ship.

## References

- [GitHub Spec Kit](https://github.com/github/spec-kit) — the upstream methodology
- [Constitution](memory/constitution.md) — Ever Works engineering principles
- [`docs/specs/README.md`](../docs/specs/README.md) — index of all specs in this repo

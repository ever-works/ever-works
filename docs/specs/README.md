# Ever Works Platform — Specs

This work holds **internal architectural specs and ADRs** for the Ever
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
│   ├── 001-pipeline-checkpointing.md
│   ├── 002-trigger-worker-callback-channel.md
│   └── 003-pnpm-overrides-strategy.md
├── architecture/                   # Cross-feature architecture docs
│   ├── README.md                   # Reading order + companion-pair index
│   ├── pipeline-overview.md        # High-level generation flow
│   ├── pipeline-executor.md        # Executor / step / modifier substrate
│   ├── trigger-integration.md      # Trigger.dev wiring
│   ├── plugin-sdk.md               # @ever-works/plugin SDK deep-dive
│   ├── settings-system.md          # 3-tier resolution + secret hygiene
│   ├── ai-facade.md                # AiFacadeService routing & model catalog
│   ├── auth.md                     # JWT + OAuth + API keys + device flow
│   ├── activity-log.md             # Audit + changelog infrastructure
│   ├── subscriptions.md            # Plans, usage ledger, billing-provider
│   ├── cache.md                    # cache_entries table + 4 consumers
│   ├── web-dashboard.md            # Next.js 16 App Router internals
│   ├── monitoring.md               # Sentry + PostHog + structured logging
│   ├── cli.md                      # Public + internal CLI architectures
│   ├── notifications-mail.md       # In-app + email delivery
│   ├── trigger-worker.md           # Trigger.dev task package + bootstrap
│   ├── mcp-server-internals.md     # OpenAPI → MCP conversion + sanitiser
│   ├── work-import.md         # Source analyzer + 3 import paths
│   ├── database.md                 # TypeORM module + repos + migrations
│   ├── events.md                   # @nestjs/event-emitter + BaseEvent
│   ├── deployment.md               # Docker + K8s + Compose + env-vars
│   └── plugin-testing.md           # @ever-works/plugin/testing harness
├── ai/                             # Cross-cutting AI / generation specs
│   ├── implementation-plan.md
│   └── tasks-checklist.md
└── features/                       # Spec Kit feature works (spec.md + plan.md + tasks.md)
    ├── advanced-prompts/
    ├── api-keys/
    ├── collections/
    ├── community-pr-processing/
    ├── comparisons/
    ├── creating-a-work/
    ├── custom-domains/
    ├── data-generator/
    ├── data-management/
    ├── work-changelog/
    ├── work-import/
    ├── work-members/
    ├── generation-cancellation/
    ├── git-operations/
    ├── item-source-validation/
    ├── markdown-generator/
    ├── mcp-server/
    ├── plugin-system/
    ├── scheduled-updates/
    ├── taxonomy-system/
    ├── website-generator/
    └── works-config/
```

## Feature Spec Index

Every user-facing feature on `develop` has a Spec Kit retrospective set
(`spec.md` + `plan.md` + `tasks.md`). The four originally pre-Spec-Kit
internal specs (`advanced-prompts`, `data-generator`,
`markdown-generator`, `website-generator`) have been migrated to the
full Spec Kit format and retain their deeper architectural `spec.md`
(see also their `acceptance.md` for the original acceptance criteria
which now live folded into `tasks.md`).

| Feature                                                            | Status        | Description                                                    |
| ------------------------------------------------------------------ | ------------- | -------------------------------------------------------------- |
| [`advanced-prompts`](features/advanced-prompts/spec)               | Retrospective | Per-work prompt overrides per pipeline step                    |
| [`api-keys`](features/api-keys/spec)                               | Retrospective | Long-lived auth tokens for CI / CLI / MCP                      |
| [`collections`](features/collections/spec)                         | Retrospective | Editorial groupings cutting across categories                  |
| [`community-pr-processing`](features/community-pr-processing/spec) | Retrospective | AI-driven processing of community-contributed PRs              |
| [`comparisons`](features/comparisons/spec)                         | Retrospective | A vs B comparison page generator                               |
| [`creating-a-work`](features/creating-a-work/spec)                 | Retrospective | Three creation methods: AI / Manual / Import                   |
| [`custom-domains`](features/custom-domains/spec)                   | Retrospective | Branded domain assignment with provider sync                   |
| [`data-generator`](features/data-generator/spec)                   | Retrospective | Data repository management and item persistence                |
| [`data-management`](features/data-management/spec)                 | Retrospective | Export / Import / GitHub Sync with secret hygiene              |
| [`work-changelog`](features/work-changelog/spec)                   | Retrospective | Audit trail of all work mutations                              |
| [`work-import`](features/work-import/spec)                         | Retrospective | Bootstrap from existing repo or Awesome List                   |
| [`work-members`](features/work-members/spec)                       | Retrospective | Role-based collaboration (Owner / Manager / Editor / Viewer)   |
| [`generation-cancellation`](features/generation-cancellation/spec) | Retrospective | Mid-flight generation cancel with four mode paths              |
| [`git-operations`](features/git-operations/spec)                   | Retrospective | `GitFacadeService` and provider plugin contract                |
| [`item-source-validation`](features/item-source-validation/spec)   | Retrospective | Reachability + AI accuracy checks per item                     |
| [`markdown-generator`](features/markdown-generator/spec)           | Retrospective | Markdown rendering pipeline                                    |
| [`mcp-server`](features/mcp-server/spec)                           | Retrospective | OpenAPI-derived MCP tool surface                               |
| [`plugin-system`](features/plugin-system/spec)                     | Retrospective | Capability-driven plugin architecture (39 first-party plugins) |
| [`scheduled-updates`](features/scheduled-updates/spec)             | Retrospective | Cron-driven generation with CAS claim and drift correction     |
| [`taxonomy-system`](features/taxonomy-system/spec)                 | Retrospective | Categories, tags, and collections in the data repo             |
| [`website-generator`](features/website-generator/spec)             | Retrospective | Static site generation pipeline                                |
| [`works-config`](features/works-config/spec)                       | Retrospective | `.works/works.yml` source-controlled work configuration        |

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

Coverage today: every user-facing feature on `develop` has a
retrospective spec set. Features still in feature branches (GitHub App
onboarding, the `hermes-agent` and `activepieces` plugins) will get
specs once they merge to `develop` and stabilise.

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

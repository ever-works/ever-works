# Architecture Specs

This work holds **cross-feature architecture specs** — deep
descriptions of the substrates that user-facing features under
`docs/specs/features/` build on top of. Each spec targets AI agents
and engineers reading the codebase and reasoning about changes,
not end users.

If you're new to the platform, **read in this order**:

1. **[`pipeline-overview`](./pipeline-overview.md)** — wide-angle:
   how a generation request becomes three GitHub repositories.
2. **[`plugin-sdk`](./plugin-sdk.md)** — how plugins are loaded,
   selected, and given context. Almost every feature touches this.
3. **[`settings-system`](./settings-system.md)** — the 3-tier
   resolution + `x-secret` hygiene contract every plugin obeys.
4. **[`trigger-integration`](./trigger-integration.md)** — how the
   API hands long-running work to the Trigger.dev worker.
5. **[`database`](./database.md)** — the TypeORM module + repository
   pattern + migration policy.

Then drill into the specific subsystem(s) your work touches.

## Spec Index

The specs come in **companion pairs** where one is wide-angle and
one is internals; both are useful but you usually want the
wide-angle first.

### Pipeline & generation

| Spec                                          | Focus                                                             |
| --------------------------------------------- | ----------------------------------------------------------------- |
| [`pipeline-overview`](./pipeline-overview.md) | Wide-angle: 4 pipeline categories, routing, 3-stage orchestrator  |
| [`pipeline-executor`](./pipeline-executor.md) | Internals: state machine, step contract, modifiers, checkpointing |
| [`work-import`](./work-import.md)             | Source-repo analyzer + the three import paths                     |

### Trigger.dev & background work

| Spec                                              | Focus                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| [`trigger-integration`](./trigger-integration.md) | API → Trigger.dev dispatch, payload contract, callback channel        |
| [`trigger-worker`](./trigger-worker.md)           | Internals: per-task NestJS bootstrap, plugin hydration, logger bridge |

### Plugins & capabilities

| Spec                                      | Focus                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| [`plugin-sdk`](./plugin-sdk.md)           | `@ever-works/plugin` deep-dive: capabilities, settings cascade, lifecycle |
| [`plugin-testing`](./plugin-testing.md)   | The `@ever-works/plugin/testing` harness for plugin unit tests            |
| [`settings-system`](./settings-system.md) | 3-tier setting resolution + JSON Schema `x-*` extensions                  |
| [`ai-facade`](./ai-facade.md)             | `AiFacadeService` routing, model catalog, retry & cost tracking           |

### Auth, audit, and access

| Spec                                | Focus                                        |
| ----------------------------------- | -------------------------------------------- |
| [`auth`](./auth.md)                 | JWT + OAuth + API keys + device flow         |
| [`activity-log`](./activity-log.md) | Audit + per-feature changelog infrastructure |

### Data & state

| Spec                        | Focus                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| [`database`](./database.md) | TypeORM module, repository pattern, forward-only migrations                                 |
| [`cache`](./cache.md)       | The `cache_entries` table and its 4 consumers (locks, checkpoints, AI cache, model catalog) |
| [`events`](./events.md)     | `@nestjs/event-emitter` + `BaseEvent` contract                                              |

### Surfaces

| Spec                                                | Focus                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| [`web-dashboard`](./web-dashboard.md)               | Next.js 16 App Router internals — routing, layouts, server actions |
| [`cli`](./cli.md)                                   | Public CLI + internal-cli architectures                            |
| [`mcp-server-internals`](./mcp-server-internals.md) | OpenAPI → MCP tool conversion + sanitiser                          |

### Operations

| Spec                                            | Focus                                                 |
| ----------------------------------------------- | ----------------------------------------------------- |
| [`deployment`](./deployment.md)                 | Docker + Kubernetes + Compose + env-var contract      |
| [`monitoring`](./monitoring.md)                 | Sentry + PostHog + structured logging                 |
| [`notifications-mail`](./notifications-mail.md) | In-app + email delivery                               |
| [`subscriptions`](./subscriptions.md)           | Plans, usage ledger, billing-provider plugin contract |

## Companion Pairs

Some specs are intentionally split into a wide-angle view + an
internals deep-dive. Read the wide-angle first:

| Wide-angle                                        | Internals                                     |
| ------------------------------------------------- | --------------------------------------------- |
| [`pipeline-overview`](./pipeline-overview.md)     | [`pipeline-executor`](./pipeline-executor.md) |
| [`trigger-integration`](./trigger-integration.md) | [`trigger-worker`](./trigger-worker.md)       |
| [`plugin-sdk`](./plugin-sdk.md)                   | [`plugin-testing`](./plugin-testing.md)       |

## Conventions

Every architecture spec in this work follows the same shape:

```markdown
# Architecture: <Subject>

**Status**: `Active` | `Draft` | `Deprecated`
**Last updated**: YYYY-MM-DD
**Audience**: <one-sentence audience description>

---

## 1. Purpose

## 2. <Domain-specific sections>

...

## N. References / See Also
```

Specs ground every claim in **a real file path or class name** from
the current `develop` branch — no speculation, no aspirations. When
the code changes, the spec changes; when the spec is wrong, file an
ADR under `docs/specs/decisions/` explaining why.

## When a spec needs to change

1. The code changed → update the spec in the same PR.
2. The architecture _should_ change → write an ADR under
   `docs/specs/decisions/`, land it, then update the spec to match
   the new reality.
3. You found the spec wrong on `develop` → fix it directly; no ADR
   needed for documentation drift.

## Related

- **Feature specs** under `docs/specs/features/` — the user-facing
  features built on top of these substrates. Start with
  [`features/data-generator/spec`](../features/data-generator/spec.md),
  [`features/markdown-generator/spec`](../features/markdown-generator/spec.md),
  and [`features/website-generator/spec`](../features/website-generator/spec.md).
- **ADRs** under `docs/specs/decisions/` — historical decisions that
  constrain current designs. See
  [`001-pipeline-checkpointing`](../decisions/001-pipeline-checkpointing.md),
  [`002-trigger-worker-callback-channel`](../decisions/002-trigger-worker-callback-channel.md),
  [`003-pnpm-overrides-strategy`](../decisions/003-pnpm-overrides-strategy.md).
- **AI / generation cross-cutting** under `docs/specs/ai/` — plans and
  task lists that touch multiple architecture substrates.
- **Spec index**: [`../README.md`](../README.md) — the top-level
  contents page across all spec types.
- **Constitution**: [`.specify/memory/constitution.md`](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md)
  at the monorepo root.

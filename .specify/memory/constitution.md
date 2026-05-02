# Ever Works Platform Constitution

> The constitution is the highest-priority document in this repo. Every feature
> spec, implementation plan, and task list MUST reconcile with these principles.
> Conflicts with the constitution are resolved in favour of the constitution.
> Non-negotiable principles are marked **(NON-NEGOTIABLE)**.

**Version**: 1.0.0
**Ratified**: 2026-05-01
**Applies to**: `apps/*`, `packages/*`, `packages/plugins/*`

---

## I. Plugin-First Architecture (NON-NEGOTIABLE)

Every external integration — AI provider, search engine, screenshot service,
deployment target, content extractor, pipeline generator — is a **standalone
plugin package** in `packages/plugins/<id>/`, declared via the `everworks.plugin`
block in its `package.json`.

**Why**: The platform's value proposition is being able to drop in a new model,
search backend, or deployment target without touching core code. Integrations
that bypass the plugin system create lock-in and break the user-level
configurability story.

**Implications for every change**:

- Adding a new external integration → new package under `packages/plugins/`,
  declares one or more capabilities, ships its own settings schema.
- Core code references plugins via **facades** (`AiFacadeService`,
  `GitFacadeService`, etc.) — never imports a specific plugin package directly.
- Plugin discovery is automatic at startup. No manual registration in core code.
- Plugins must build with `tsup`, ship ESM, and test with `vitest`.

## II. Capability-Driven Resolution (NON-NEGOTIABLE)

The platform asks "give me a plugin that can do X for this scope" and a facade
resolves the answer based on a **three-tier settings cascade**: directory →
user → admin. UI and API code MUST request capabilities through facades; they
MUST NOT hard-code a specific plugin id.

**Why**: Per-directory plugin overrides are the foundation of the platform's
flexibility (Directory A uses OpenAI + Brave, Directory B uses Anthropic +
Tavily). Hardcoding plugin ids in core code defeats this and forces every
deployment to use the same providers.

**Implications**:

- New capability surface → new facade (capability interface + resolver).
- Settings cascade is enforced by the facade, not by callers.
- A plugin can advertise multiple capabilities (Tavily provides both `search`
  and `content-extractor`). Resolvers handle this.

## III. Source-of-Truth Repositories (NON-NEGOTIABLE)

Every directory's content lives in **GitHub repositories owned by the
end-user** — never inside our database. The platform's database stores
metadata, schedules, history, and audit logs; the items, categories,
configuration, and the website itself live in user-owned repos.

**Why**: Users own their content. They can leave the platform at any time and
keep their directory running. They can edit content via PRs. Governance
(branch protection, code review) flows through their own GitHub setup.

**Implications**:

- The data repo (`<directory-slug>-data`) holds YAML config + JSON items.
- The website repo (`<directory-slug>-site`) holds the deployed site.
- `works.yml` in the data repo is the source-controlled config, kept in sync
  by the platform on every successful generation.
- Database rows for items/categories/tags are derived state, not the source
  of truth.

## IV. Background Work Goes Through Trigger.dev

Long-running, retryable, scheduled, or fan-out work runs as a **Trigger.dev
task**, not as an in-process async function. Cron schedules use the
`schedules.task()` API; one-shot fan-out uses regular `task()`. In-process
execution remains an option only as a fallback when Trigger.dev is not
configured.

**Why**: Generation runs are long (minutes), use heavy resources, and must
survive worker restarts. Trigger.dev gives us idempotent retries, durable
state, observability, cancellation, and concurrency control out of the box.
Re-implementing those primitives in the API process is busywork.

**Implications**:

- New "I need to run X every N minutes" → Trigger.dev cron task.
- New "I need to fan out work for each directory in a batch" → Trigger.dev
  task triggered by a parent.
- Mutual exclusion across overlapping ticks → atomic SQL `UPDATE … WHERE` if
  you have an owning row, else `DistributedTaskLockService`.
- API endpoints that kick off work return `202 Accepted` immediately; they
  must not block on the worker.

## V. Database Migrations Are Forward-Only

Schema changes ship as **TypeORM migration files** generated from entity
diffs. `synchronize: true` is forbidden in any environment that talks to a
real database. Migrations are forward-only — never destructive without a
preserved-data path.

**Why**: Production data is irreplaceable. Auto-sync silently drops columns
on entity removal. Rollback strategy must be explicit (down migrations) and
always available.

**Implications**:

- New entity field → `pnpm typeorm migration:generate` from `apps/api/`.
- Renaming a column → two migrations (add new + backfill, remove old after
  deploy) — never a single rename that loses data on rollback.
- All migrations live in `apps/api/src/database/migrations/` and run on
  boot when `RUN_MIGRATIONS=true`.

## VI. Tests Are A Prerequisite, Not A Follow-Up

New code ships with tests. Plugin packages use **Vitest**; the agent package
uses **Jest** (with `moduleNameMapper` resolving `@ever-works/*` to source);
the API uses **Jest**; the web app uses **Playwright** for E2E. Failing CI
blocks merges.

**Why**: The plugin system means a regression in one plugin can break
unrelated directories. Test isolation per plugin (vitest in each package)
catches breakages locally before they ship.

**Implications**:

- New facade method → test against a mock plugin.
- New plugin → unit tests for capability methods, integration tests for the
  settings schema if non-trivial.
- New API endpoint → e2e test in `apps/api/test/`.
- New web page → Playwright spec covering the golden path.

## VII. User Privacy & Secret Hygiene (NON-NEGOTIABLE)

Secrets (API keys, OAuth tokens, webhooks) are stored encrypted, scoped to
user/directory, and never logged or returned in API responses. Plugin
settings declare secrets via the `x-secret: true` JSON Schema extension; the
settings UI hides them; the API serialiser strips them.

**Why**: Users entrust us with credentials for their AI providers, GitHub,
Vercel, etc. A leak — in logs, error messages, or API responses — is a
breach.

**Implications**:

- New plugin setting that holds a credential → `x-secret: true` in its JSON
  Schema. No exceptions.
- New log statement in a code path that touches plugin settings → must
  redact `x-secret` fields. Use the existing redaction helpers.
- New API DTO that returns plugin settings → strips `x-secret` fields server-
  side; the UI never sees them after initial save.
- Activity-log entries describing config changes log the **field name**, not
  the value, for secret fields.

## VIII. Single Source of Truth for Plugin Counts & Lists

Plugin counts, capability lists, and "what plugins are shipped" appear in
exactly one canonical doc: `docs/plugin-system/built-in-plugins.md`. Other
docs link to it. This avoids the drift problem where four pages each claim
a different plugin count.

**Why**: We've seen this drift in practice — `architecture.md`, `overview.md`,
`comparison.md`, `monorepo-structure.md` all carried plugin counts that
fell out of sync as plugins were added.

**Implications**:

- New plugin → add to `built-in-plugins.md` first; other pages link there.
- Counts in supporting docs can be approximate ("~40 plugins") or omitted;
  only the canonical doc holds the precise count.

## IX. Specs Are Behaviour-First

Every feature spec describes **what the system does for the user**, not how
the code is structured. Implementation details (specific classes, file
paths, library calls) belong in the implementation plan, not the spec.

**Why**: A spec that's pinned to current internals goes stale the moment
the code is refactored. A spec that captures user-observable behaviour
remains valid through arbitrary refactors and is reusable for new
implementations (e.g. CLI vs API surface for the same feature).

**Implications**:

- Feature spec sections: User Scenarios, Functional Requirements, Key
  Entities, Acceptance Criteria. **No code, no class names.**
- Plan sections: Architecture, Tech Choices, Data Model, Phasing.
- Tasks sections: ordered steps with explicit file paths.

## X. Forward-Looking Backwards Compatibility

API endpoints, plugin SDK contracts, and database schemas are versioned.
Breaking changes ship as a new version (`/api/v2/...`,
`@ever-works/plugin@2.x`) with the previous version maintained for at least
one release cycle. Deprecation notices precede removal by ≥ 30 days.

**Why**: External users of our API and plugin authors outside this repo
deserve a stable contract.

**Implications**:

- Renaming a public field on a DTO → add the new field, alias the old field,
  deprecate the old one in docs, remove after the deprecation window.
- Removing a plugin SDK base class → publish under a new major version.
- Renaming a database column users query directly via reports → migration
  that adds the new column and a view that re-exports the old name.

---

## Governance

- Amendments to the constitution require a PR with a rationale section and
  sign-off from at least one maintainer.
- A new principle goes into the next minor version; a change to a
  non-negotiable principle requires a major version bump.
- Specs that conflict with the constitution must be updated before merge.
- Plans/tasks may flag a constitutional gap (`gates`) — the gap must be
  resolved (either by amending the constitution or revising the plan)
  before implementation begins.

## Compliance Checklist

For any feature spec or plan, run through these gates before merging:

- [ ] No new external integration without a corresponding plugin package
      (Principle I).
- [ ] No hardcoded plugin id outside the plugin package itself (Principle II).
- [ ] Content lives in user repos, not the database (Principle III).
- [ ] Long-running work uses Trigger.dev (Principle IV).
- [ ] Schema changes ship as forward-only migrations (Principle V).
- [ ] Tests accompany the change (Principle VI).
- [ ] Secrets carry `x-secret: true` and are never logged (Principle VII).
- [ ] Plugin count/list updates the canonical doc, not the supporting ones
      (Principle VIII).
- [ ] Spec is behaviour-first, plan owns the implementation (Principle IX).
- [ ] Backwards-compatible API/SDK/schema changes (Principle X).

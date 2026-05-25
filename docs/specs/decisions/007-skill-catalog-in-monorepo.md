# ADR-007: Platform Skill catalog ships in-monorepo

## Status

**Proposed — 2026-05-25.** Pending operator review on [QUESTIONS-agents-skills-tasks.md A2](../QUESTIONS-agents-skills-tasks.md#a2--skill-catalog-in-monorepo-or-separate-repo).

## Date

2026-05-25

## Context

The new Skills feature ([features/skills/spec.md](../features/skills/spec.md)) ships a starter catalog of platform-supplied Skills (≥10 entries in v1, expected to grow to ~1000+ over time). Three places the catalog could live were considered:

1. **In the platform monorepo** at `apps/api/src/skills/catalog/<slug>/<slug>.md`, read at boot.
2. In a separate repo (`ever-works/skills-catalog`) cloned/synced at boot.
3. DB-seeded from a one-off seeder.

The same question was answered for Mission Templates a few weeks before this feature; that decision landed in-monorepo (`packages/agent/src/missions/mission-template.config.ts`).

## Decision

**The platform Skill catalog ships in the platform monorepo** at `apps/api/src/skills/catalog/<slug>/<slug>.md`, with companion `metadata.json` files for tags + default `allowed-tools` + version.

The catalog is read into memory at API boot by `SkillCatalogService` (in-process cache, no DB round-trip on hot path). New catalog entries land via normal PR review against `develop`.

When a tenant installs a catalog skill, a `skills` row is created with `ownerType='tenant'`, `ownerId=userId`, `sourceCatalogSlug` + `sourceCatalogVersion` populated; the body is **copied** at install time so tenant skills don't break when the catalog evolves.

## Consequences

### Positive

- **Atomic versioning with code.** When the API changes how it injects skill bodies, the catalog can be updated in the same PR.
- **PR review for catalog content.** Same CodeRabbit / Codex / Sonar bot review loop as code changes.
- **Zero new infrastructure.** No cron clone, no sync conflict, no second deploy pipeline.
- **Consistent with Mission Templates catalog precedent.**
- **Fast read path.** In-memory cache means `GET /skills/catalog?limit=50` is sub-50 ms.

### Negative

- **Repo bloat at scale.** ≥1000 markdown files in `apps/api/src/skills/catalog/` adds ~10 MB to the platform repo over time. Mitigated by: a future move to a separate repo is a one-day migration if it bites.
- **Cross-repo PRs for community contributions.** Community contributors must PR the main platform repo to add a catalog skill. Higher friction than a dedicated skills-catalog repo. Mitigated by: catalog skills are platform-curated by default; community contributions go through tenant skills first, then get promoted.
- **Catalog updates ship with platform releases.** A new skill can't be hotfixed independently of the platform. Mitigated by: catalog skills are immutable in tenant copies after install; only new tenants pick up new versions.

## Alternatives Considered

### 1. Separate `ever-works/skills-catalog` repo

**Rejected for v1.** Adds infrastructure (clone-at-boot or webhook-driven sync), requires a versioning contract between catalog repo and platform code, and complicates dev setup. Worth revisiting at ~500+ skills.

### 2. DB seed

**Rejected.** Loses Git review, requires migrations for every catalog change, and the body is harder to diff/lint in PRs.

### 3. Hybrid — in-monorepo for v1 starters; external repo for community contributions

**Rejected for v1 simplicity.** Possible v2 if community contribution volume grows. Both stores would need a uniform read path; complexity not worth it yet.

## Related

- [`007 ↔ ADR-007 (this)`](./007-skill-catalog-in-monorepo.md)
- [`features/skills/spec.md §3.2`](../features/skills/spec.md)
- Constitution Principle III (Source-of-Truth Repos): user-installed skills DO live in Git (per-Mission/Work repos) — only the **shipped catalog** is in-monorepo.
- Mission Templates catalog precedent: `packages/agent/src/missions/mission-template.config.ts`

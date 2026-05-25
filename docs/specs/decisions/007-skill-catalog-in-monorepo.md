# ADR-007: Platform Skill catalog ships in-monorepo

## Status

**Superseded — 2026-05-25.** This decision was **incorrect** and has been replaced. Reversed by operator instruction during round 6 review of PR [#1017](https://github.com/ever-works/ever-works/pull/1017).

## The corrected decisions

The Skill catalog is **NOT** in the platform monorepo. Two superseding ADRs codify the correct architecture:

1. **[ADR-012 — Skills as plugin](./012-skills-as-plugin.md)**: Skills are a plugin capability (`skills-provider`); `"Ever Works Skills"` is the first-party plugin that supplies the default catalog.
2. **[ADR-014 — No hardcoded catalogs](./014-no-hardcoded-catalogs.md)**: All catalogs (Skills included) live in separate `ever-works/*` GitHub repos, not in the platform monorepo. The Skill catalog repo is **[`ever-works/skills`](https://github.com/ever-works/skills)**.

## Why the original decision was wrong

The original (now-superseded) reasoning argued that in-monorepo catalog storage gave "atomic versioning with code" and "smaller v1 surface." Both pros are real but overruled by stronger arguments:

- **Platform monorepo bloat.** Skills are expected to grow into the thousands of entries; bloats `ever-works/ever-works` indefinitely.
- **Community contribution friction.** PRs against a small focused catalog repo are dramatically easier than PRs against the platform monorepo (which gates contributions through full lint + type-check + test suites).
- **Plugin-first architecture.** Constitution Principle I says external integrations are plugins. Skills source code shouldn't be a special case — it should be a plugin like every other capability.
- **Per-tenant flexibility.** A plugin model lets tenants enable multiple `skills-provider` plugins simultaneously (community catalogs + Ever Works default).

## Historical record (collapsed for transparency)

The original "Proposed" content of this ADR (catalog in `apps/api/src/skills/catalog/`, MIT-licensed, in-process cache, etc.) is intentionally NOT preserved in this file — references to it elsewhere should be treated as out-of-date. The two superseding ADRs (012 + 014) are now the canonical source.

If you need the original text for archaeology, see git history: `git log -p -- docs/specs/decisions/007-skill-catalog-in-monorepo.md`.

## Related

- ADR-012 (Skills as plugin) — superseding.
- ADR-014 (No hardcoded catalogs) — superseding.
- Operator-facing rule: [`ever-works/workspace:knowledge/notes/2026-05-25-no-hardcoded-catalogs-rule.md`](https://github.com/ever-works/workspace/blob/develop/knowledge/notes/2026-05-25-no-hardcoded-catalogs-rule.md).

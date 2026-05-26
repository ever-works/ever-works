# ADR-012: Skills are a plugin capability; "Ever Works Skills" is the first-party plugin shipping the default catalog

## Status

**Accepted — 2026-05-25.** Operator instruction during round 6 review of PR [#1017](https://github.com/ever-works/ever-works/pull/1017). **Supersedes the relevant part of [ADR-006](./006-agents-skills-tasks-as-core-not-plugins.md)** (Skills are no longer "core not plugin").

## Date

2026-05-25

## Context

ADR-006 (round 1) declared that Agents, Skills, and Tasks are all core domain concepts that USE plugins but ARE NOT plugins. Round 6 review by the operator reversed two of those three:

> "For Skills, I think that's a good idea to implement it as plugin too — 'Ever Works Skills' — and later other community members can provide own 'Skills' plugins that integrate other popular skills catalogs. So yes, let's do it as plugin too!"

This ADR captures the new direction for Skills specifically. (Task tracking gets its own parallel ADR-013; Agents stay core per the corrected ADR-006.)

## Decision

**Skills are a plugin capability.** The platform defines a new plugin category `skills-provider` with the contract `ISkillsProviderPlugin`. The first-party plugin **"Ever Works Skills"** is the default `skills-provider`, shipping the platform's curated catalog from the [`ever-works/skills`](https://github.com/ever-works/skills) repo (per [ADR-014](./014-no-hardcoded-catalogs.md)).

Future community plugins can implement the same capability — e.g.:

- An "Anthropic Skills" plugin loading from Anthropic's catalog format.
- An "AWS Q Developer Skills" plugin loading from AWS's catalog.
- A "Custom Skill Library" plugin loading from a self-hosted Git URL.

A tenant can have one or more `skills-provider` plugins enabled at once; resolved skills come from the union of all enabled providers, deduplicated by slug with priority by plugin install order.

### What stays core

The following remain core domain concerns and do not move into plugin packages:

- **Skill DB schema** — `skills` and `skill_bindings` tables stay in the platform `packages/agent/src/entities/`. The plugin returns Skills; the platform stores user-installed copies + bindings.
- **Skill resolution + injection logic** — `SkillBindingRepository.resolveActive()`, `AiFacadeService.assembleSystemMessage()`. Plugin-agnostic.
- **The Skills UI** — `/skills` page, the Skills tab on Agents/Works/Missions/Ideas. Plugin-agnostic.
- **The `skills:` array in `works.yml` / `mission.yml`** — schema stays in the platform's Zod definitions.

The plugin's job is narrow: **source the catalog**. Read entries from somewhere (a Git repo, an API, a local folder) and return them in the contract shape.

### `ISkillsProviderPlugin` contract

Defined in `packages/plugin/src/contracts/capabilities/skills-provider.interface.ts`:

```typescript
export interface SkillCatalogEntry {
	slug: string;
	title: string;
	description: string;
	frontmatter: SkillFrontmatter;
	body: string;
	version: string;
	tags: string[];
	sourceUrl?: string; // link to the canonical source
}

export interface ISkillsProviderPlugin extends IPlugin {
	readonly providerName: string;

	/** List all available catalog entries (paginated). */
	listEntries(options: { limit: number; offset: number; tags?: string[]; search?: string }): Promise<{
		entries: SkillCatalogEntry[];
		total: number;
	}>;

	/** Fetch one entry by slug. */
	getEntry(slug: string): Promise<SkillCatalogEntry | null>;

	/** Optional: signal that the catalog has updated. */
	checkForUpdates?(installedVersions: Record<string, string>): Promise<{
		updated: { slug: string; oldVersion: string; newVersion: string }[];
	}>;
}
```

### `SkillsFacadeService` (new)

Mirrors the `AiFacadeService` shape. Resolves enabled `skills-provider` plugins for the user/work scope, calls their methods, dedupes, returns. Skill UI + injection always go through this facade — never directly into a specific plugin.

## "Ever Works Skills" — the first-party plugin

Lives at `packages/plugins/everworks-skills/`. `package.json` `everworks.plugin` block:

```json
{
	"id": "everworks-skills",
	"name": "Ever Works Skills",
	"category": "skills-provider",
	"capabilities": ["skills-provider"],
	"defaultForCapabilities": ["skills-provider"],
	"visibility": "public",
	"settingsSchema": {
		/* repo ref, local path override, refresh interval */
	}
}
```

Implementation:

- On `onLoad()`, clones [`ever-works/skills`](https://github.com/ever-works/skills) (`--depth 1`) to a tmp dir; reads all `.md` files; parses frontmatter; caches the parsed result.
- Settings (per [`settings-system.md`](../architecture/settings-system.md)): `repoRef` (default `latest`), `localPath` (optional, for self-hosted/offline), `cacheTtlSeconds` (default 3600).
- `listEntries`, `getEntry`, `checkForUpdates` read from the cache, refreshing on TTL expiry.

## Consequences

### Positive

- **Symmetric with existing plugin architecture.** Skills join `ai-provider`, `git-provider`, `search`, etc. as a real capability — no special-case "core not plugin" carve-out.
- **Community contribution surface.** Anyone can ship an alternative `skills-provider` plugin pointing at their own catalog.
- **Self-hosted users can fully detach** by enabling only the local-path override (via plugin settings) — no monorepo dependency on the catalog content.
- **Multiple-catalog union.** A tenant can enable "Ever Works Skills" AND "Awesome AI Skills" plugins simultaneously; resolved set is the union.
- **Aligns with ADR-014** (catalogs in separate repos) — the plugin is the consumer of the repo.

### Negative

- **One more plugin to maintain.** Counts toward `built-in-plugins.md` Constitution VIII inventory. Mitigated by: this is the cost of generality.
- **Indirection cost.** A read like "list installed skills" now goes through `SkillsFacadeService → ISkillsProviderPlugin`. Mitigated by: caching at the plugin layer means the per-call cost is process-memory only.
- **`ISkillsProviderPlugin` is a new public contract.** Once shipped, breaking changes require deprecation cycles per Constitution X.

### Mitigations

- **Plugin SDK contract test** ensures every `skills-provider` plugin honors the contract (per existing `packages/plugin/src/contracts/__tests__/` pattern).
- **Default-on for new tenants** — "Ever Works Skills" is `defaultForCapabilities: ['skills-provider']` so users get a working catalog immediately.
- **Fallback when no provider enabled** — `SkillsFacadeService.listEntries()` returns empty; UI shows "No skills providers enabled — install one from /plugins to see the catalog."

## What changes in the Skills feature spec

The Skills product behavior described in [`features/skills/spec.md`](../features/skills/spec.md) is unchanged. What changes is the **implementation packaging**:

- Was: `apps/api/src/skills/catalog/` (in-monorepo) + `SkillCatalogService` in `apps/api/`.
- Now: `ever-works/skills` repo + `packages/plugins/everworks-skills/` plugin + `SkillsFacadeService` in `packages/agent/`.

User-installed skills, custom skills, agent-bound skills, the resolution hierarchy, injection rules, frontmatter shape — all unchanged.

## Alternatives Considered

### 1. Keep Skills as core (status quo of ADR-006)

**Rejected per operator instruction.** Misses the community-extension opportunity.

### 2. Single plugin only (no capability + no facade)

**Rejected.** Locks users to "Ever Works Skills"; no extension story.

### 3. Plugin for catalog source, but no facade indirection

**Rejected.** Means every consumer (Agents, generators, Skills page) has to know which plugin is enabled. Facade is the cleaner pattern, matching `AiFacadeService` precedent.

## Related

- ADR-006 (partially superseded — Skills no longer "core not plugin").
- ADR-007 (Skill catalog in-monorepo — superseded).
- ADR-013 (Task tracking as plugin — parallel decision).
- ADR-014 (No hardcoded catalogs — `ever-works/skills` repo).
- [`features/skills/spec.md`](../features/skills/spec.md), [`features/skills/plan.md`](../features/skills/plan.md) — product behavior unchanged; implementation packaging updated.
- Constitution Principle I (Plugin-First) and Principle II (Capability-Driven Resolution) — this ADR brings Skills under both.

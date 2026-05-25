# ADR-014: All catalogs / templates / collections live in separate GitHub repos, not in the platform monorepo

## Status

**Accepted — 2026-05-25.** Operator instruction during round 6 review of PR [#1017](https://github.com/ever-works/ever-works/pull/1017). Codifies the rule for all future feature work.

## Date

2026-05-25

## Context

Across the Agents / Skills / Tasks spec set, multiple "catalog-shaped" datasets emerged:

- Mission Templates — already on develop, already in separate repos
- Agent templates — proposed (ADR-011) in `ever-works/agents`
- Skill catalog — proposed (ADR-007, now superseded) in-monorepo
- Task templates — proposed (deferred to v2) in-monorepo

Each catalog was being designed independently with a different storage strategy. The operator's round 6 instruction:

> "It's a HARD rule that we should NOT hardcode into our codebase any templates etc. So Mission templates, Agents catalog, Skill catalog, should all be in separate repos on GitHub in the Ever Works org. Same as Task Templates — those tasks like bug-reports, pr-review, weekly-status task and so on, we can have separate repo called `ever-works/tasks` and load such tasks templates from it."

This ADR codifies the rule platform-side. The Workspace knowledge note `knowledge/notes/2026-05-25-no-hardcoded-catalogs-rule.md` ([blob link](https://github.com/ever-works/workspace/blob/develop/knowledge/notes/2026-05-25-no-hardcoded-catalogs-rule.md)) is the operator-facing version.

## Decision

**Every catalog / template collection / curated reference dataset shipped with the Ever Works platform lives in a separate GitHub repo under the `ever-works` organization.** The platform repo (`ever-works/ever-works`) contains the code that reads catalogs; it does NOT contain catalog content.

Concrete inventory at the time of writing:

| Catalog                | Repo                                                                        | Notes                                            |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| Mission Templates       | one repo per template (e.g. `ever-works/p2p-marketplace-mission-template`)  | already on develop; the precedent.              |
| Agent templates         | [`ever-works/agents`](https://github.com/ever-works/agents)                  | new; to be created during Agents v1 impl.       |
| Skill catalog           | [`ever-works/skills`](https://github.com/ever-works/skills)                  | new; supersedes ADR-007's in-monorepo posture.  |
| Task templates          | [`ever-works/tasks`](https://github.com/ever-works/tasks)  | new; created when Task Templates v2 ships.     |

This list will grow as future catalog-shaped features land.

## Pattern every catalog repo follows

1. **Top-level layout**:
    - One folder per entry (Agent templates, Mission Templates), OR one file per entry (Skills, simple Task templates).
    - `README.md` — repo overview + format docs.
    - `CONTRIBUTING.md` — community PR guide.
    - `LICENSE` — **MIT** (intentionally permissive for content; see §"License posture" below).
    - `.github/workflows/validate.yml` — lints MD + validates manifests against a Zod schema on every PR.

2. **Per-entry manifest**:
    - Each entry self-describes via a manifest (e.g. `agent.yml` for Agent templates, frontmatter for Skills).
    - Versioned via semver.

3. **Release cadence**:
    - Tagged releases via semver.
    - Platform default reads the latest `v*` tagged release.

## Platform-side consumption pattern

Every catalog has a paired NestJS service in the platform that wraps it:

```typescript
@Injectable()
export class XCatalogService {
    // env vars
    private ref = process.env.EVER_WORKS_X_REF ?? 'latest'; // ref-pinning
    private localPath = process.env.EVER_WORKS_X_PATH;       // self-hosted / offline override

    // 1-hour cache in the existing cache_entries TypeORM-backed cache
    async listEntries(): Promise<EntryMeta[]> {
        const cached = await this.cache.get(`x-catalog:${this.ref}`);
        if (cached) return cached;
        const entries = this.localPath
            ? await this.readFromLocalClone(this.localPath)
            : await this.cloneAndRead(this.ref);
        await this.cache.set(`x-catalog:${this.ref}`, entries, { ttl: 3600 });
        return entries;
    }

    // ...
}
```

- Cache backed by existing `cache_entries` (TypeORM-backed; multi-pod distributed).
- `git clone --depth 1 -b <ref>` into a temp directory; read; tear down.
- `EVER_WORKS_<KIND>_REF` env var pins to a release ref (default: latest semver tag).
- `EVER_WORKS_<KIND>_PATH` env var points at a local clone for self-hosted / air-gapped installs.
- Admin endpoint `POST /admin/catalogs/<kind>/refresh` force-busts the cache without a restart.

## License posture — platform is AGPLv3; catalog content is MIT

**This is an intentional split. Both halves are deliberate.**

- The **Ever Works platform** (`ever-works/ever-works`) is licensed under **AGPL-3.0** (see `LICENSE` in the repo root, confirmed in `docs/specs/architecture/plugin-sdk.md` and `package.json` plugin manifests). AGPL's copyleft applies to the platform code and to derivative works built on it.
- The **catalog content repos** (`ever-works/agents`, `ever-works/skills`, `ever-works/tasks`, Mission Template repos) are licensed under **MIT**. Operator confirmed in round 9:
    > "Skills catalog is MIT, but note that platform is AGPLv3 !!!!!! Same Agents in they own repo, let's them be MIT too."

### Why the split makes sense

- **Catalog content is data, not code.** Markdown bodies, frontmatter, RRULE strings, prompt text — none of it links into the platform binary. The platform consumes it at runtime via the plugin facade.
- **Catalog reuse should be friction-free.** A user (or a competitor, or a downstream community) can copy `ever-works/skills` into their own product without inheriting AGPL obligations. That maximizes adoption + community contribution.
- **Platform copyleft stays intact.** Anyone who runs the Ever Works platform and modifies it must still publish those changes (per AGPL §13). Consuming MIT-licensed catalog content doesn't dilute that.

### What this means for each catalog repo's `LICENSE` file

Every catalog repo's `LICENSE` file is **the standard MIT license** with copyright "Ever Works contributors". The repo's `README.md` MUST include a short note clarifying the platform-vs-content license split so contributors aren't confused.

### Contributing guidance lives in each repo

Per operator S3 answer (round 9):
> "S3 — in separate skills repo. Same for Agents repo btw."

The `CONTRIBUTING.md` for community contributions lives **inside each catalog repo**, not in the platform repo. Each catalog's `CONTRIBUTING.md` covers: schema validation, MD style guide, PR review checklist, MIT-licensing acknowledgement on contribution.

---

## What this does NOT cover

The rule applies to **catalog / reference / template content** only. It does NOT apply to:

- **Code** — entities, services, controllers stay in the platform monorepo.
- **User-installed copies** — when a tenant installs a Skill, the copy lives in the platform's DB / Git. The rule is about the **source catalog**, not the per-tenant installed copies.
- **Specs, runbooks, ADRs** — documentation about the platform itself stays in `ever-works/ever-works`.
- **Tests / fixtures** — small inline fixtures for unit tests stay co-located. Larger or shared fixtures use vendored snapshots of the catalog repo for offline test runs.

## Consequences

### Positive

- **Decoupled lifecycle.** Catalog content evolves on its own cadence; platform stays untouched.
- **Community contribution surface.** Small focused repos are dramatically easier to PR than the monorepo.
- **No monorepo bloat.** Catalogs can grow to thousands of entries without bloating `ever-works/ever-works`.
- **Easier inspection by AI tools.** An LLM agent can scan a small catalog repo and suggest entries.
- **One mental model.** "If it's a catalog, it's a Git repo." No special cases.

### Negative

- **Network dependency.** Catalog reads need internet OR a local-clone override env var. Mitigated by 1-hour cache + `EVER_WORKS_<KIND>_PATH` override.
- **More repos to maintain.** ~4 today, growing. Ever Works team owns curation lifecycle for each.
- **Offline-by-default test setup.** Tests must either mock the catalog services or use vendored fixture snapshots.

### Mitigations

- **Vendored fixture snapshots in `test/fixtures/`** for unit + CI tests so we don't need network during test runs.
- **Cache-first reads** so a transient network failure during the 1-hour cache window is a no-op.
- **Clear error UI** when cache is empty AND network is down: "Templates unavailable — create from scratch."

## Alternatives Considered

### 1. In-monorepo (status quo before round 6)

**Rejected per operator instruction.** Bloats the monorepo, raises contribution friction, couples catalog lifecycle to platform releases.

### 2. NPM packages

**Rejected.** Heavier than needed for static MD / YAML. Doesn't fit the contribution model.

### 3. DB-seeded catalogs

**Rejected.** Loses Git review on catalog changes; needs migrations for every entry add/remove.

### 4. Hybrid (some catalogs in-repo, some external)

**Rejected per operator instruction.** Mixed strategy creates a "where does this kind live?" branch in every implementer's head.

## Related

- Operator-facing rule: `ever-works/workspace:knowledge/notes/2026-05-25-no-hardcoded-catalogs-rule.md`.
- ADR-007 (Skill catalog in-monorepo) — **superseded by this ADR**; Skill catalog now in `ever-works/skills`.
- ADR-011 (Agent templates in separate repo) — first instance of this pattern; this ADR generalizes.
- ADR-010 (Templates stay independent) — clarifies that independence and remote-storage are orthogonal.

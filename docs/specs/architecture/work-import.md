# Architecture: Work Import

**Status**: `Active`
**Last updated**: 2026-05-02
**Audience**: AI agents and engineers extending import sources,
debugging the analyzer, or adding new ecosystem-specific enrichment
prompts.

---

## 1. Purpose

Work import is the platform's "bootstrap from an existing
repository" flow. It supports three source types — **data
repository** (an existing Ever Works data repo), **Awesome README**
(a GitHub Awesome List), and **link existing** (point at a repo
without copying anything) — and routes each through a different
import path while sharing common analyzer + executor infrastructure.

This spec covers the **source-repo analyzer** (auto-detection), the
**three import paths**, the **`.works/works.yml` integration**, the
**enrichment prompt** for Awesome imports, and the
**post-completion sync** that ensures the resulting work looks
identical to one created via AI Creation.

The user-facing description lives in
[`features/work-import/spec`](../features/work-import/spec.md);
this spec is the implementation deep-dive.

## 2. Module Layout

```
packages/agent/src/import/
├── index.ts
├── import.module.ts
├── source-repo-analyzer.service.ts        # Detects source type
├── import-executor.service.ts             # Orchestrates the three paths
├── enrichment-prompt.utils.ts             # Awesome README → seed prompt
├── source-sync-support.ts                 # Helpers for awesome enrichment
└── __tests__/
```

Plus the Trigger.dev wrapper:

```
packages/tasks/src/tasks/trigger/
└── work-import.task.ts               # Trigger.dev task wrapper
```

And the API surface:

```
apps/api/src/works/import/           # Controllers + DTOs
```

## 3. The Source-Repo Analyzer

`SourceRepoAnalyzerService.analyze(url, options)` detects what flavour
of source the URL points at. The algorithm:

1. Resolve the URL to `(owner, repo)`. Strip protocol and `.git`.
2. Verify it exists via `GitFacadeService.repositoryExists`.
3. Probe for **data-repo markers**:
    - `.works/works.yml` at root
    - `data/` work with at least one item file
    - `categories.yml` (optional but indicative)
    - root `.works/works.yml` (see [`works-config`](../features/works-config/spec.md))
4. Probe for **Awesome README markers**:
    - `README.md` with at least 5 link-list entries
    - Repo description containing "awesome" or repo name starting `awesome-`
    - Top-level README structured as `## Category\n- [name](url) — desc`
5. Default to **link-existing** if both probes fail (the user can
   still link the URL, the platform won't try to import data).

Returns:

```ts
interface SourceRepoAnalysis {
	sourceType: 'data-repo' | 'awesome-readme' | 'unknown';
	owner: string;
	repo: string;
	branch: string;
	worksConfig?: ParsedWorksConfig; // from works-config service
	awesomeMetadata?: {
		title: string;
		description: string;
		categoryCount: number;
		linkCount: number;
	};
}
```

The analyzer is **idempotent** — calling it twice on the same URL with
no repo changes produces identical results. Cached for 5 minutes via
the [cache module](./cache.md) to keep the analyze-then-import flow
snappy.

## 4. The Three Import Paths

### 4.1 Data Repo Import

**When** the analyzer detected a `data-repo` source.

```
Source repo                          Platform
    │                                    │
    ├─ clone ───────────────────────────▶│
    │                                    ├─ read .works/works.yml
    │                                    ├─ read .works/works.yml (if present)
    │                                    ├─ read categories.yml
    │                                    ├─ read tags.yml
    │                                    ├─ read collections.yml
    │                                    ├─ enumerate data/<slug>/item.yml
    │                                    │
    │                                    ▼
    │                              Insert work + relations + repo refs
    │                                    │
    │                                    ├─ Optionally re-clone the source as
    │                                    │   <slug>-data, OR link the existing
    │                                    │   repo (link-existing flavour)
```

The data-repo path **doesn't run a generation**. Items, taxonomy,
config — everything that's already in the source repo is copied
verbatim. Best for "I exported from another instance and want to
restore here" or "I built data by hand and want the platform to
manage it from here."

### 4.2 Awesome README Import

**When** the analyzer detected `awesome-readme`.

```
Source README                        Platform
    │                                    │
    ├─ fetch README.md ─────────────────▶│
    │                                    ├─ Build enrichment prompt (§5)
    │                                    ├─ Insert work shell
    │                                    ├─ Create 3 git repos
    │                                    ├─ Dispatch work-generation
    │                                    │   task with the seed prompt
    │                                    │   + expansionFactor knob
    │                                    │
    │                                    ▼
    │                            (long-running pipeline runs)
    │                                    │
    │                                    ▼
    │                            Items committed to <slug>-data
```

The Awesome path **does** run a generation. The README is parsed into
a list of seed items with categories; the AI pipeline takes those as
research seeds and expands by the user-configured `expansionFactor`
(1.5x, 2x, 2.5x default, 3x, 5x). The pipeline plugin is restricted to
**Agent Pipeline** or **Claude Code** — the Standard Pipeline can't
fetch arbitrary URLs autonomously, which is what the source URL
parsing requires.

### 4.3 Link Existing

**When** the user chose "link existing" or the analyzer returned
`unknown` and the user proceeded anyway.

```
Source repo                          Platform
    │                                    │
    │                                    ├─ Insert work pointing
    │                                    │   data-repo at the source URL
    │                                    │   (no clone, no copy)
    │                                    │
    │                                    ▼
    │                              Future generations write directly
    │                              to this repo
```

Pure metadata link. No items inserted, no repos created, no
generation. The work immediately appears in the dashboard with
zero items; the user can manually add items, trigger an AI
generation, or wait for the scheduled cadence to populate it.

## 5. The Enrichment Prompt (Awesome Path)

`enrichment-prompt.utils.ts` exports `buildEnrichmentPrompt(awesomeMetadata,
expansionFactor)` which produces the **seed prompt** the pipeline
plugin receives. The prompt has three concerns:

1. **Source description** — "This Awesome List covers X, with N
   categories and M links."
2. **Source items** — the parsed list of `{name, url,
description?, category?}` entries from the README, formatted as
   a structured table the agent can consume.
3. **Expansion instructions** — "Discover roughly N additional items
   beyond the source. Aim for a final size of M items."

The agent pipeline observes the `source` field in its first AI call
and treats those entries as **seeds** — items it should normalise and
include — while doing additional web search to find the items the
expansion factor calls for.

The deduplication step compares discovered items against the seeds by
URL and name to prevent the agent from "discovering" something the
README already had.

## 6. The Import Executor

`ImportExecutorService.execute(input)` is the single entry point both
the API controller and the Trigger.dev task call:

```ts
interface ImportInput {
	userId: string;
	sourceUrl: string;
	sourceType: 'data-repo' | 'awesome-readme' | 'link-existing';
	name?: string; // override work name
	slug?: string; // override slug
	expansionFactor?: number; // awesome only
	pipeline?: string; // awesome only — must be agent-pipeline or claude-code
	providers?: ProvidersDto; // awesome only
	repositoryOwner?: string; // data-repo / awesome only
	importMode: 'copy' | 'link'; // data-repo only
}
```

Returns a `WorkImportResult` with the new work id, the
created (or linked) repos, and (for awesome) the dispatched
generation run id.

## 7. Path Selection Logic

Inside the executor:

```ts
if (sourceType === 'awesome-readme') {
	const work = await this.createWorkShell(input);
	const repos = await this.createThreeGitRepos(input, work);
	const seedPrompt = buildEnrichmentPrompt(input.awesomeMetadata, input.expansionFactor);
	const runId = await this.generationService.dispatch({
		workId: work.id,
		promptOverride: seedPrompt,
		pipelineId: input.pipeline,
		providers: input.providers
	});
	return { workId: work.id, repos, generationRunId: runId };
}

if (sourceType === 'data-repo') {
	const work = await this.createWorkShell(input);
	if (input.importMode === 'copy') {
		await this.copyDataRepoToOwnedRepo(input.sourceUrl, work);
	} else {
		work.dataRepository = parseRepositoryReference(input.sourceUrl);
	}
	await this.copyEntities(work); // members, plugins, schedule from .works/works.yml
	return { workId: work.id };
}

// link-existing
const work = await this.createLinkedWork(input);
return { workId: work.id };
```

Each branch ends with a `work_imported` activity-log entry
recording the source type and source URL.

## 8. `.works/works.yml` Integration

When importing a data repo, the executor reads `.works/works.yml` from the
source via `WorksConfigService` (see
[`features/works-config/spec`](../features/works-config/spec.md)) and
uses its values to:

- Pre-fill `name`, `slug`, `description` if not overridden in the
  request.
- Pre-set `pipeline`, `aiProvider`, `searchProvider`, `screenshotProvider`,
  `contentExtractor` from `providers`.
- Pre-set the schedule cadence from `schedule`.

This means a data repo with a `.works/works.yml` round-trips cleanly between
Ever Works instances — export from one, import into another, end up
with the same configuration without the user re-entering it.

## 9. Validation

Three validation gates:

| Gate                             | When                                                           | Failure mode                                                   |
| -------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| Source URL accessibility         | At analyze time                                                | `404 Source repository not found or inaccessible`              |
| Pipeline compatibility (awesome) | Awesome paths only — must be `agent-pipeline` or `claude-code` | `400 Pipeline 'standard-pipeline' cannot import Awesome lists` |
| Plugin availability              | Awesome paths — every requested provider must be enabled       | `400 Plugin '<id>' is not enabled for this user`               |

All three run **before** any side effect (no orphan works from
a half-completed validation).

## 10. Cancellation

Awesome imports inherit cancellation from the underlying
`work-generation` task — see
[`features/generation-cancellation/spec`](../features/generation-cancellation/spec.md).
Data-repo and link-existing imports are synchronous and short, so they
don't expose a cancel surface.

## 11. Observability

Each import path emits:

- `work_imported` activity-log entry with `details.sourceType`,
  `details.sourceUrl`, `details.expansionFactor` (when applicable).
- For Awesome paths, the dispatched generation's run id appears in
  the activity-log entry's `details.generationRunId` so the
  History tab can link to the generation.
- Sentry breadcrumbs for the analyzer, executor, and each git
  operation.

## 12. Tests

`packages/agent/src/import/__tests__/`:

- `source-repo-analyzer.service.spec.ts` — covers all three
  detection paths plus edge cases (empty repo, non-existent repo,
  private repo with valid auth).
- `import-executor.service.spec.ts` — exercises the executor with
  mocked git facade + generation service.
- `enrichment-prompt.utils.spec.ts` — verifies the seed-prompt
  structure for various Awesome List shapes.

End-to-end import tests live in
`apps/api/test/works/import.e2e-spec.ts`.

## 13. Constitution Reconciliation

| Principle                   | How import respects it                                                               |
| --------------------------- | ------------------------------------------------------------------------------------ |
| I — Plugin-first            | Pipeline + AI providers come from plugins; the import flow doesn't hardcode any.     |
| II — Capability-driven      | Awesome path validates plugin capability availability before dispatch.               |
| III — Source-of-truth repos | Data-repo `copy` mode creates new user-owned repos; `link` mode reuses the source.   |
| IV — Trigger.dev            | Awesome generations run as Trigger.dev tasks.                                        |
| V — Forward-only migrations | No new schema; uses existing `works` + relations.                                    |
| VI — Tests                  | All three paths covered by unit + e2e suites.                                        |
| VII — Secret hygiene        | OAuth tokens used to read the source repo are never logged.                          |
| VIII — Plugin counts        | N/A.                                                                                 |
| IX — Behaviour-first        | This spec describes observable import behaviour.                                     |
| X — Backwards-compat        | New source types add new analyzer probes + executor branches; existing paths stable. |

## 14. References

- Source:
    - `packages/agent/src/import/`
    - `packages/tasks/src/tasks/trigger/work-import.task.ts`
    - `apps/api/src/works/import/`
- Related specs:
    - [`features/work-import/spec`](../features/work-import/spec.md) (user-facing)
    - [`features/works-config/spec`](../features/works-config/spec.md)
    - [`features/creating-a-work/spec`](../features/creating-a-work/spec.md)
    - [`pipeline-executor`](./pipeline-executor.md)
    - [`trigger-worker`](./trigger-worker.md)
- User docs: [`docs/features/work-import.md`](../../features/work-import.md)

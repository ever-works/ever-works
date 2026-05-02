# Feature Specification: Creating a Directory

**Feature ID**: `creating-a-directory`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

Users can create a directory through three paths: **AI Creation** (provide a
prompt, the platform researches and generates), **Manual** (create an empty
scaffold and populate later), and **Import** (bootstrap from an existing
git repository — data repo, Awesome README, or link-existing). Each path
ends with a fully wired directory: three git repositories, a database row,
and (for AI/Import) generation kicked off as a background job.

## 2. User Scenarios

### 2.1 Primary scenarios

- **AI Creation**: **Given** I'm on the New Directory page with a connected
  git provider, **when** I choose "AI Creation", enter a name + prompt,
  pick a pipeline (or accept the default), and submit, **then** the
  platform creates the directory + three git repos and dispatches an AI
  generation job; the page redirects to the directory detail view where
  progress streams live.
- **Manual**: **Given** I want full control, **when** I choose "Manual"
  and supply name, slug, description, and a repository owner, **then**
  the platform creates an empty scaffold with no AI involvement and the
  detail page shows zero items.
- **Import — data repo**: **Given** I have a previously-generated Ever
  Works data repo, **when** I import its URL, **then** the platform
  detects the `config.yml`, copies items/categories/tags verbatim, and
  creates the directory with the existing content.
- **Import — Awesome README**: **Given** I supply a GitHub Awesome List,
  **when** I configure expansion factor and providers, **then** the
  platform parses the README as research seeds and runs an
  Agent-Pipeline-or-Claude-Code generation that expands the source list
  by the configured factor.
- **Import — link existing**: **Given** I want the platform to manage an
  existing data repo without copying it elsewhere, **when** I pick
  "Link existing", **then** the platform records the repo as the data
  repo and treats subsequent generations as updates against it.

### 2.2 Edge cases & failures

- **Given** I haven't connected a git provider, **when** I try AI or
  Manual creation, **then** the form shows an error directing me to
  connect a provider before continuing.
- **Given** the slug I supply (Manual) doesn't match
  `[a-z0-9]+(-[a-z0-9]+)*`, **when** the form validates, **then** the
  create call is rejected with a clear "invalid slug" message.
- **Given** the slug I generated (AI/Import) collides with an existing
  directory I own, **when** the platform detects it, **then** I'm
  offered a unique alternative or an error if I'm not signed in as the
  owner.
- **Given** the admin has enforced a specific pipeline globally, **when**
  I open the AI Creation form, **then** the pipeline picker is locked
  to the enforced choice.
- **Given** I select a provider that isn't configured (no API key
  plugged in), **when** the form rendered, **then** that provider is
  shown as grayed-out and unselectable.
- **Given** a deploy provider isn't selected, **when** generation
  completes, **then** the website repo is created but not deployed and
  a banner prompts me to set up deployment.

## 3. Functional Requirements

- **FR-1** The platform MUST support exactly three creation methods: AI,
  Manual, Import (with three import sub-types: data repo, Awesome README,
  link-existing).
- **FR-2** AI Creation MUST accept a name + prompt as required inputs and
  expose Advanced Settings for picking pipeline, AI provider, search
  provider, screenshot provider, and content extractor.
- **FR-3** AI Creation MUST resolve plugin defaults via the cascade:
  user form selection → directory-level defaults (when regenerating) →
  admin-enforced pipeline → system defaults.
- **FR-4** AI Creation MUST refuse provider choices that don't have an
  installed/enabled plugin (UI greys them out; the API rejects them
  with `400`).
- **FR-5** Manual creation MUST require name, slug (matching
  `[a-z0-9]+(-[a-z0-9]+)*`), description (≤ 500), and a repo owner.
- **FR-6** Import MUST detect source-repo shape (data repo / Awesome
  README / unknown) by reading the candidate paths defined by
  [`directory-import`](../directory-import/spec.md) and
  [`works-config`](../works-config/spec.md).
- **FR-7** Awesome README import MUST allow only pipelines that support
  autonomous URL fetching: Agent Pipeline and Claude Code (Standard
  Pipeline is excluded).
- **FR-8** Awesome README import MUST expose an expansion factor with
  five presets: 1.5x, 2x, 2.5x (default), 3x, 5x.
- **FR-9** Every successful creation MUST create three git repos:
  `<slug>-data`, `<slug>`, `<slug>-website`.
- **FR-10** AI and Import (non-link) creations MUST dispatch generation
  as a background Trigger.dev job; the API responds before generation
  completes.
- **FR-11** Each pipeline plugin MAY contribute additional form fields
  via `form-schema-provider`; the New Directory form MUST render those
  fields when the pipeline is selected.
- **FR-12** The system MUST emit an activity-log entry for every
  creation with `directory_created` action and the chosen method
  (`ai` / `manual` / `import-data` / `import-awesome` / `link`).

## 4. Non-Functional Requirements

- **Performance**: form submission returns within 5 s for AI/Manual; the
  server creates DB row + repos synchronously and dispatches generation
  asynchronously. Import preview returns within ~3 s for typical repos.
- **Reliability**: if any of the three repo creates fails, the platform
  rolls back the DB row and surfaces the failure (no orphan directories).
- **Security & privacy**: requires authenticated session; uses the
  user's git provider plugin credentials.
- **Observability**: activity log + Sentry breadcrumbs trace the full
  create→generate handoff.
- **Compatibility**: pipeline form-field schemas can evolve without the
  main form changing.

## 5. Key Entities & Domain Concepts

| Entity / concept     | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| Creation method      | `ai` / `manual` / `import-data` / `import-awesome` / `link-existing`      |
| Repository ecosystem | Three repos per directory: `<slug>-data`, `<slug>`, `<slug>-website`      |
| Provider cascade     | form → directory defaults → admin-enforced → system defaults              |
| Expansion factor     | Awesome-import knob: how aggressively to discover items beyond the source |
| Form-schema provider | Plugin capability that contributes pipeline-specific form fields          |
| Repository owner     | Personal user account or git org under which repos are created            |

## 6. Out of Scope

- Cloning a directory from another user (use export/import flow).
- Switching creation method mid-flow (each is a separate form).
- Creating a directory without any git provider (always required).
- Creating a directory targeting two git providers simultaneously.

## 7. Acceptance Criteria

- [x] All three methods produce a fully wired directory.
- [x] Provider cascade resolves correctly across all four levels.
- [x] Pipeline form-fields render dynamically when pipeline changes.
- [x] Awesome import excludes Standard Pipeline.
- [x] Repo creation is atomic — no orphans on partial failure.
- [x] Slug validation is enforced on Manual; auto-generated otherwise.
- [x] Tests cover all five creation flavours plus failure paths.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I — Plugin-first**: pipeline / AI / search / screenshot / extractor
      are all plugins.
- [x] **II — Capability-driven**: form pulls plugins by capability, not by
      id.
- [x] **III — Source-of-truth repos**: three repos per directory; user
      owns them.
- [x] **IV — Trigger.dev**: generation is dispatched async.
- [x] **V — Forward-only migrations**: directory schema evolution covered
      by additive migrations.
- [x] **VI — Tests**: covered by unit + e2e tests for each path.
- [x] **VII — Secret hygiene**: provider creds come from the encrypted
      plugin-settings store; the form never echoes secrets.
- [x] **VIII — Plugin counts**: pipelines list pulled from the live
      registry, not hardcoded.
- [x] **IX — Behaviour-first**: this spec describes the user flow.
- [x] **X — Backwards-compat**: pipeline form-fields are
      schema-versioned via the plugin SDK.

## 10. References

- User-facing doc: [`../../../features/creating-a-directory.md`](../../../features/creating-a-directory.md)
- Related:
    - [`directory-import/spec.md`](../directory-import/spec.md)
    - [`works-config/spec.md`](../works-config/spec.md)
    - [`plugin-system/spec.md`](../plugin-system/spec.md)
- Implementation: `apps/web/src/app/[locale]/directories/new/`,
  `apps/api/src/directories/`,
  `packages/agent/src/services/directory-generation.service.ts`

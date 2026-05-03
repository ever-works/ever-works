# Task Breakdown: Markdown Generator

**Feature ID**: `markdown-generator`
**Plan**: `./plan.md`
**Status**: `Done` (Retrospective)
**Last updated**: 2026-05-02

---

## Phase 1 — MarkdownRepository

- [x] **T1**. `MarkdownRepository` class at
      `packages/agent/src/markdown-generator/markdown-repository.ts`
      with git operations: `clone`, `commit`, `push`, `createBranch`,
      `createPullRequest`.
- [x] **T2**. README operations: `writeReadme`, `readReadme`.
- [x] **T3**. Detail-page operations: `writeDetails(slug, content)`,
      `readDetails(slug)`, `removeDetails(slug)`, `listDetails()`.
- [x] **T4**. `resetFiles()` clears `README.md` and `details/`
      while preserving `.git`, `LICENSE`, and any non-generated
      files.
- [x] **T5**. Repository auto-creation: when the markdown repo does
      not exist, create it via `GitFacadeService.createRepository`
      and seed a LICENSE file before the first commit.

## Phase 2 — ReadmeBuilder

- [x] **T6**. `ReadmeBuilder.build(options)` at
      `packages/agent/src/markdown-generator/readme-builder.ts`.
- [x] **T7**. Header section:
    - Default: `# {name}\n\n{description}`
    - Custom header: replace if `overwriteDefaultHeader: true`,
      prepend otherwise.
- [x] **T8**. Table of Contents: anchor links to each category
      header in the document; ordered by category `priority`.
- [x] **T9**. Per-category section: H2 heading + 2-column markdown
      table (Name → details link, Description → item description).
- [x] **T10**. Item ordering inside each category:
    1. Featured items first
    2. By `order` field (ascending)
    3. Alphabetically by name
- [x] **T11**. Footer section:
    - Default footer with Contributing + License blocks + Ever Works attribution
    - Custom footer: replace if `overwriteDefaultFooter: true`,
      append otherwise.
- [x] **T12**. Unit tests cover: default-only build, custom-header
      replace + prepend, custom-footer replace + append, featured
      ordering, alpha tie-break.

## Phase 3 — Detail-page renderer

- [x] **T13**. Function that, given an `ItemData`, returns:
    - `# {name}`
    - description paragraph
    - `## Overview` with `item.markdown` content (or fallback string)
    - `## Links` block with the source URL (and any other links)
    - `## Tags` rendered as inline-code spans
    - Last-updated footer line
- [x] **T14**. Unit tests cover: missing markdown field, missing
      tags array, special characters in URLs, multi-line description.

## Phase 4 — Service orchestration

- [x] **T15**. `MarkdownGeneratorService.initialize` at
      `packages/agent/src/markdown-generator/markdown-generator.service.ts`.
- [x] **T16**. Flow:
    1. Resolve git token via `GitFacadeService`.
    2. Clone (or auto-init then clone) markdown repository.
    3. If the data generator returned a `prUpdate`, switch to that branch.
    4. Read `Work.readmeConfig` for header/footer customization.
    5. `MarkdownRepository.resetFiles()`.
    6. `ReadmeBuilder.build(...)` and write `README.md`.
    7. For each item, write `details/<slug>.md`.
    8. Commit with a clear message; push.
- [x] **T17**. Cancellation: thread `AbortSignal` into clone/push
      calls; abort writes and surface a cancelled error if signal
      fires.
- [x] **T18**. Skip path: if the data generator reported
      `newItemsCount === 0 && updatedItemsCount === 0`, skip
      markdown generation entirely (orchestrator gates on this).

## Phase 5 — PR mode integration

- [x] **T19**. When the data generator created a PR branch,
      reuse the same branch for markdown commits — both sets of
      changes land on the same PR.
- [x] **T20**. PR body extension: append a "README Update" section
      summarising new/updated/removed item counts to the data
      generator's PR body.

## Phase 6 — Error handling

- [x] **T21**. Repository-doesn't-exist → auto-create + initial
      commit + retry the run.
- [x] **T22**. Clone retry with exponential backoff (3 attempts).
- [x] **T23**. Per-file write failure does not abort the whole run;
      logs the failure and continues, then surfaces partial-success
      warning in the result.
- [x] **T24**. Push retry with backoff; final failure surfaces as a
      structured error.

## Phase 7 — Tests

- [x] **T25**. ReadmeBuilder unit tests (header/TOC/category/footer).
- [x] **T26**. Detail-page renderer unit tests (edge cases above).
- [x] **T27**. `MarkdownGeneratorService.initialize` tests with
      mocked `MarkdownRepository` and mocked `GitFacadeService`.
- [x] **T28**. e2e test that runs the full generate → write →
      commit flow against a temp git repo.

## Phase 8 — Docs

- [x] **T29**. User-facing doc explaining the markdown repo layout
      and customization options under `docs/features/`.
- [x] **T30**. Cross-link from
      [`data-generator`](../data-generator/spec.md) and
      [`website-generator`](../website-generator/spec.md) specs.
- [x] **T31**. Retrospective spec / plan / tasks (this set).

## Phase 9 — Quality gates

- [x] **T32**. `pnpm format && pnpm lint && pnpm test && pnpm build`
      green.
- [x] **T33**. `pnpm --filter ever-works-docs build` produces no
      broken-link warnings.

## Definition of Done

- [x] README and detail pages are deterministic for a given input set
- [x] PR mode shares the same branch with the data generator
- [x] Custom header / footer behave per `overwriteDefault*` flag
- [x] Stale `details/<slug>.md` files cleared on every run
- [x] Constitution gates in `spec.md` §9 confirmed satisfied

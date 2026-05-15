# Task Breakdown: Item Markdown Editor

**Feature ID**: `item-markdown-editor`
**Plan**: `./plan.md`
**Status**: `In Progress`
**Last updated**: 2026-05-15

---

## Phase 1 — Contracts & DTO validation

- [x] **T1**. Add `markdown?: string` to
      `packages/contracts/src/api/generator/submit-item.dto.ts` and
      `update-item.dto.ts`.
- [x] **T2**. Add `@IsOptional() @IsString() @MaxLength(100000)` `markdown`
      field to `packages/agent/src/items-generator/dto/submit-item.dto.ts`
      and `update-item.dto.ts`.
- [x] **T3**. Extend validator tests in
      `packages/agent/src/items-generator/dto/dto.spec.ts`:
    - SubmitItemDto: accepts string `markdown`, rejects non-string,
      rejects > 100,000 chars.
    - UpdateItemDto: same.

## Phase 2 — Generator pipeline wiring

- [x] **T4**. Pass `submitItemDto.markdown` into `itemData` in
      `ItemSubmissionService.submitItem` (existing
      `itemWithMarkdown.markdown || stub` logic then respects it).
- [x] **T5**. Broaden the type constraint on
      `DataRepository.updateItemMetadata` to include `'markdown'` in the
      `Pick<ItemData, …>` set.
- [x] **T6**. In `ItemSubmissionService.updateItem`, compute
      `markdownChanged`, push `markdown` into `itemUpdates` when changed,
      and call `data.writeItemMarkdown(updatedItem, value)` so the
      `<slug>.md` file (the canonical render source on the site) is
      synced too. Update commit message and PR body accordingly.

## Phase 3 — Web UI

- [x] **T7**. New component
      `apps/web/src/components/works/detail/items/MarkdownPreview.tsx` —
      `react-markdown` + `remark-gfm`, mirroring `ChatMarkdown` typography.
- [x] **T8**. New component
      `apps/web/src/components/works/detail/items/MarkdownBodyField.tsx` —
      label + textarea + Preview toggle (dynamic-imports
      `MarkdownPreview`).
- [x] **T9**. `AddItemForm.tsx` — add `markdown: string` to
      `ItemFormData`, render `<MarkdownBodyField>` before the images
      section.
- [x] **T10**. `AddItemModal.tsx` — initialise + reset `markdown: ''`;
      include `markdown` in the submit payload (omit when blank).
- [x] **T11**. `ItemActions.tsx` — add "Edit content" dropdown entry and
      `EditContentDialog`; no-op-when-unchanged guard before save.
- [x] **T12**. Add new i18n keys to `apps/web/messages/en.json`
      (`addModal.markdown*`, `addModal.showPreview`,
      `addModal.hidePreview`, `editContent*`).

## Phase 4 — Docs & rollout

- [x] **T13**. This spec + plan + tasks + acceptance under
      `docs/specs/features/item-markdown-editor/`.
- [ ] **T14**. Follow-up i18n PR translates the new `en.json` keys into
      the other 20 locales (handled by the existing translation sweep
      workflow, not this PR).
- [ ] **T15**. Flip spec status from `Draft` to `Implemented` after PR
      merges; flip plan/tasks status from `In Progress` to `Done`.
- [ ] **T16**. Run `pnpm format && pnpm lint && pnpm type-check` at the
      monorepo root and confirm green before requesting review.

## Definition of Done

- All Phase 1–3 checkboxes ticked (above).
- DTO tests passing locally and in CI.
- `pnpm lint` and `pnpm type-check` green at the monorepo root.
- Constitution gates in `spec.md` §9 all confirmed satisfied.
- Spec + plan + tasks + acceptance landed in
  `docs/specs/features/item-markdown-editor/`.

# Feature Specification: Item Markdown Editor

> Behaviour-first spec per [Constitution Principle IX](../../../../.specify/memory/constitution.md#ix-specs-are-behaviour-first).

**Feature ID**: `item-markdown-editor`
**Branch**: `feat/ew-item-markdown-editor`
**Status**: `Draft`
**Created**: 2026-05-15
**Last updated**: 2026-05-15
**Owner**: ever-works

---

## 1. Overview

Work owners can author and edit the long-form markdown body that appears on
each item's detail page on the generated site. Today the platform writes a
stub body (`# Name\n\nDescription\n\n[source_url](source_url)`) for every
new item because no UI surface or API field accepts user-authored content;
the underlying contract and generator have always supported a `markdown`
field but it was unreachable from outside the platform. This feature opens
that channel end-to-end from the dashboard through to the user's data
repository.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** a work owner is on the "Add item" modal, **when** they type
  markdown in the new "Content (Markdown)" field and submit, **then** the
  item lands in the data repo with their markdown written to
  `data/<slug>/<slug>.md` and mirrored on the YAML `markdown` field — and
  the next site generation renders that body verbatim instead of the stub.
- **Given** an existing item without authored content, **when** the owner
  picks "Edit content" from the item's dropdown menu, **then** the dialog
  opens with whatever body the item currently has (stub or authored),
  pre-filled in a textarea for editing.
- **Given** the owner edits the body and clicks "Update item", **then** the
  platform writes the new content to `data/<slug>/<slug>.md`, updates the
  YAML mirror, commits with message `Update <name> content`, and pushes.
  Either direct-commit to default or open a PR according to the
  "Create Pull Request" toggle.
- **Given** the owner toggles the "Preview" button on the markdown field,
  **then** the rendered markdown appears below the textarea using the same
  `react-markdown` + `remark-gfm` rendering used elsewhere on the platform.

### 2.2 Edge cases & failures

- **Given** the markdown body is empty on create, **when** the item is
  submitted, **then** the existing stub-fallback behaviour applies (no
  regression — `# Name\n\nDescription\n\n[url](url)` is written).
- **Given** the markdown body exceeds 100,000 characters, **when** the
  request reaches the API, **then** validation rejects it with a
  `maxLength` error before any git work begins. The UI surfaces the error.
- **Given** the body is unchanged between dialog open and save, **when**
  the user clicks "Update item", **then** no commit is created (no-op
  close) — avoids churn-only commits in the data repo.
- **Given** another user/process edited the item between dialog open and
  save, **then** the platform's normal last-write-wins commit semantics
  apply (no optimistic locking introduced in this feature).
- **Given** the user authors MDX custom components (`<Tag>`, `<TagList>`,
  etc.) that exist only on the directory-web-template render path, **then**
  the platform preview renders them as their plain-text fallback — this is
  acknowledged and documented, not a bug.

## 3. Functional Requirements

- **FR-1** The "Add item" form MUST present an optional "Content (Markdown)"
  textarea that accepts up to 100,000 characters.
- **FR-2** The form MUST offer an in-place rendered preview of the markdown
  using GitHub-Flavoured Markdown.
- **FR-3** When the user submits an item with markdown body, the platform
  MUST persist that body to `data/<slug>/<slug>.md` and to the YAML
  `markdown` field on the item record in the data repo.
- **FR-4** When the user submits an item with no markdown body, the
  platform MUST continue to write the existing stub fallback so the site
  always has a rendered detail page.
- **FR-5** The item dropdown menu MUST expose an "Edit content" action
  that opens a dialog pre-populated with the current item's markdown body.
- **FR-6** Saving an unchanged body MUST NOT produce a commit.
- **FR-7** The Update endpoint MUST accept an optional `markdown` field.
  Submitting a changed `markdown` MUST write both files (`<slug>.md` and
  YAML), commit with a content-update message, and push.
- **FR-8** The API MUST validate `markdown` as an optional string with a
  100,000-character maximum length; longer payloads MUST be rejected with
  HTTP 400 before any git work is performed.
- **FR-9** Adding `markdown` to existing DTOs MUST remain backwards
  compatible: omitting the field preserves prior behaviour for callers
  that do not yet know about it (Principle X).

## 4. Non-Functional Requirements

- **Performance**: client-side render of the preview SHOULD only fetch the
  `react-markdown` chunk when the user opens the preview pane (deferred
  import). The Add-item modal MUST NOT regress its initial bundle size by
  more than ~5 KB gzipped (only the textarea + dynamic-import shim ship
  eagerly).
- **Reliability**: a write failure on either of the two channels
  (`<slug>.md` or YAML) MUST surface the error to the user and abort the
  commit; partial writes MUST NOT be pushed.
- **Security & privacy**: markdown content is non-secret user content.
  Body text MUST NOT be logged (only existence/size is acceptable in
  debug logs).
- **Observability**: the existing `Add ...` / `Update ... content` commit
  messages are sufficient audit trail; no new activity-log event needed.
- **Compatibility**: contract change is additive — new field is optional
  on every DTO it lands on.

## 5. Key Entities & Domain Concepts

| Entity / concept    | Description                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ItemData.markdown` | Existing optional long-form body field on an item; already serialised into YAML and into `<slug>.md` by the generator. |
| `<slug>.md` file    | The canonical source the directory-web-template renders; takes precedence over the YAML `markdown` field.              |
| Content dialog      | New UI surface in the item's dropdown menu for editing the body of an existing item without re-creating it.            |

## 6. Out of Scope

- Rich-text WYSIWYG editing. Plain textarea + preview only.
- MDX-component-aware preview (`<Tag>` etc.). The preview deliberately
  shows GFM fallback only; the site keeps doing the MDX render.
- Automatic AI generation of item bodies — handled separately by the
  generator pipeline, not this feature.
- Item-level revision history beyond what git already gives us in the
  data repo.
- Translations of the new UI labels beyond `en.json` — added to the
  follow-up i18n sweep that already covers the other locales.

## 7. Acceptance Criteria

- [ ] Adding an item with a non-empty `markdown` body writes the literal
      text to `data/<slug>/<slug>.md` and to the YAML.
- [ ] Adding an item with an empty `markdown` body writes the stub
      fallback unchanged.
- [ ] "Edit content" opens a dialog seeded with the current body.
- [ ] Saving an unchanged body does NOT create a commit.
- [ ] Saving a changed body writes both files, commits with a
      `Update <name> content` message, and either pushes to main or
      opens a PR based on the toggle.
- [ ] The API rejects markdown bodies over 100,000 chars with a 400.
- [ ] Existing SubmitItem / UpdateItem callers that don't send `markdown`
      continue to work unchanged.
- [ ] All new validators are covered by `dto.spec.ts` cases.

## 8. Open Questions

- `[NEEDS CLARIFICATION: should we add a soft warning at, say, 50,000 chars
for unusually long bodies, or trust the hard 100k cap?]` — Punt, hard cap
  only for now.
- `[NEEDS CLARIFICATION: do we want a follow-up to mirror the markdown
field on the platform's Item dashboard list / ItemCard (so users can see
whether an item has authored content)?]` — Tracked as a follow-up.

## 9. Constitution Gates

- [x] Plugin-first (Principle I) — N/A, no new external integration.
- [x] Capability-driven (Principle II) — N/A, no plugin behaviour touched.
- [x] Source-of-truth repos preserved (Principle III) — content lives in
      the user's data repo, not the platform DB.
- [x] Long-running via Trigger.dev (Principle IV) — N/A, request-scoped
      git operations only (existing pattern).
- [x] Forward-only migrations (Principle V) — no schema change.
- [x] Tests accompany (Principle VI) — DTO validation specs added.
- [x] Secret hygiene (Principle VII) — N/A.
- [x] Plugin counts canonical (Principle VIII) — N/A.
- [x] Behaviour-first spec (Principle IX) — this document.
- [x] Backwards-compatible (Principle X) — additive optional field.

## 10. References

- Related feature: [`data-generator`](../data-generator/spec.md) — how
  item content gets written to the data repo on a full generate.
- Related contract: `packages/contracts/src/item/item.types.ts` — the
  pre-existing `markdown?: string` field on `ItemData`.
- Related site renderer: directory-web-template
  `apps/web/components/item-detail/server-item-content.tsx` — consumer
  of the `markdown` channel.

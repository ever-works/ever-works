# Acceptance: Item Markdown Editor

**Feature ID**: `item-markdown-editor`
**Spec**: `./spec.md`
**Last updated**: 2026-05-15

A reviewer running through this checklist before signing off the PR
should be able to tick every box.

## Add flow

- [ ] Open the dashboard for any work, hit "Add item", scroll to the new
      "Content (Markdown)" field, type `# Hello\n\nWorld`, submit.
- [ ] After the success toast, navigate to the work's data repo on
      GitHub. The new item directory contains `<slug>.md` whose body is
      literally `# Hello\n\nWorld`.
- [ ] The same item's `<slug>.yml` carries a top-level `markdown:` key
      with the same content.
- [ ] Add a second item with the markdown field left blank. Confirm the
      generated `<slug>.md` matches the pre-existing stub
      (`# <Name>\n\n<Description>\n\n[<url>](<url>)`).
- [ ] Toggle "Preview" while typing. Confirm the rendered preview
      appears below the textarea and matches GFM expectations
      (headings, lists, tables, code fences).

## Edit flow

- [ ] On any item card, open the dropdown menu. A new "Edit content"
      entry sits below "Edit display".
- [ ] Click it. The dialog opens with the current `markdown` body
      pre-filled. Confirm it matches what's on disk in the data repo.
- [ ] Make no edits and click "Update item". No new commit lands on the
      data repo (server returns success without pushing).
- [ ] Edit the body, leave "Create Pull Request" off, click "Update item".
      A new direct commit lands on default with message
      `Update <name> content`. The `<slug>.md` file content matches the
      saved body; the YAML `markdown` field matches too.
- [ ] Edit the body again with "Create Pull Request" on. A PR is
      opened with title `Update content for <name> - <timestamp>` and a
      body that mentions content was updated.

## API contract

- [ ] `POST /api/works/:id/items/submit` accepts an optional `markdown`
      field. Old clients that omit it still succeed.
- [ ] `PUT /api/works/:id/items/update` accepts `markdown`. Old clients
      that omit it still succeed.
- [ ] Sending `markdown` longer than 100,000 chars returns HTTP 400 with
      a `maxLength` validation error, before any git work is performed.

## Tests & quality

- [ ] `packages/agent/src/items-generator/dto/dto.spec.ts` includes
      passing cases for the new `markdown` field on both DTOs.
- [ ] `pnpm lint` and `pnpm type-check` are green at the monorepo root.

## Site render

- [ ] Trigger a site regeneration for a work whose item has authored
      markdown. Visit the item-detail page on the generated site and
      confirm the new body renders via the existing
      `next-mdx-remote`-based item-detail renderer.

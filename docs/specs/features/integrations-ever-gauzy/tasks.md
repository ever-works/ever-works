# Task Breakdown: Ever Gauzy Integration (Ever Works side)

**Feature ID**: `integrations-ever-gauzy`
**Last updated**: 2026-10-15

## Platform (see each spec's tasks.md)

- [~] **T1** Domain events — [`domain-events/tasks.md`](../domain-events/tasks.md).
- [~] **T2** Integration keys — [`integration-keys/tasks.md`](../integration-keys/tasks.md).
- [ ] **T3** Record visibility — [`record-visibility/tasks.md`](../record-visibility/tasks.md).
- [~] **T4** Integration API v1 — [`integrations-api-v1/tasks.md`](../integrations-api-v1/tasks.md) (contract published).

## Settings UI (EW-P1-7)

- [x] **T5** "New integration key" dialog with the "Ever Gauzy" preset (`IntegrationKeysSection`, EW-P1-7 PR).
- [x] **T6** Deep link `?new=integration&preset=ever-gauzy`.
- [x] **T7** Integration keys list with Rotate / Revoke.
- [x] **T8** "Ever Gauzy" integrations card (`/settings/integrations/ever-gauzy`; webhook subscriptions join with T9 / EW-P1-5).
- [ ] **T9** Settings → Webhooks page.
- [ ] **T10** Emails page placeholder → wizard (EW-P4-3).

## Verification

- [ ] **T11** Stage curl checks with a real integration key.
- [ ] **T12** Joint end-to-end run with Gauzy stage.

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

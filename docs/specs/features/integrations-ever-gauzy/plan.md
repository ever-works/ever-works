# Implementation Plan: Ever Gauzy Integration (Ever Works side)

**Feature ID**: `integrations-ever-gauzy`
**Spec**: [`spec.md`](./spec.md)
**Status**: `Draft`
**Last updated**: 2026-10-15

Order: the platform items first (they unblock Gauzy), then the UI.

## Phase 1 — Platform (tracked in their own specs)

- **P1.1** [`domain-events`](../domain-events/plan.md) — EW-P1-1.
- **P1.2** [`integration-keys`](../integration-keys/plan.md) — EW-P1-2.
- **P1.3** [`record-visibility`](../record-visibility/plan.md) — EW-P1-3.
- **P1.4** [`integrations-api-v1`](../integrations-api-v1/plan.md) — EW-P1-4, EW-P1-5, EW-P1-6.

## Phase 2 — Settings UI (EW-P1-7)

- **P2.1** API keys page: "New integration key" dialog (name, org pins, scope checklist, "Ever Gauzy" preset).
- **P2.2** Deep link `?new=integration&preset=ever-gauzy`.
- **P2.3** Integration keys list (last use, scopes, pins, Rotate, Revoke).
- **P2.4** Settings → Integrations → "Ever Gauzy" card (keys of kind `ever-gauzy` + their webhook subscriptions; revoke
  disables both).
- **P2.5** Settings → Webhooks page (list, create, deliveries, redeliver).
- **P2.6** Emails page `alert()` placeholder → real wizard (EW-P4-3).

## Phase 3 — Joint verification

- **P3.1** Create a real integration key on stage; curl: whoami, list with `updatedSince`, feed paging, webhook delivery
  with signature verification, a 412 on a stale `If-Match`, a 409 `transition_blocked`.
- **P3.2** Joint end-to-end run with Gauzy stage (coordinated on the plan's STATUS board).

## Dependencies

- Gauzy side: `ever-co/ever-gauzy` work items G-P1-1 … G-P5 (plan doc 06).

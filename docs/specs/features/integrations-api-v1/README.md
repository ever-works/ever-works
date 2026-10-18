# Integration API v1 (`/api/integrations/v1`)

The stable, versioned API that external systems — first **Ever Gauzy** — use to read and write Ever Works data and to
follow its changes. Plan items **EW-P1-4** (sync primitives and P1 resources), **EW-P1-5** (webhooks v2), **EW-P1-6**
(transitions for sync, reopen) and the P2–P4 resource additions.

- [spec.md](./spec.md) — the contract: common rules, identity and feed, event envelope and catalog, webhooks v2, resources
- [plan.md](./plan.md) — implementation plan
- [tasks.md](./tasks.md) — task breakdown
- [contract/](./contract/README.md) — **machine-readable contract**: JSON Schemas, event catalog, examples, webhook
  signature test vectors

**Contract version:** `v1-draft.15` (2026-10-18; history in [spec.md](./spec.md) §8–17 and on the plan's STATUS board). **Owner:** the Ever Works integration lane.

Related specs: [`domain-events`](../domain-events/README.md) (the outbox that feeds `/events` and webhooks v2),
[`integration-keys`](../integration-keys/README.md) (the `ew_int_` principal every route here requires),
[`record-visibility`](../record-visibility/README.md) (which rows an integration may read),
[`integrations-ever-gauzy`](../integrations-ever-gauzy/README.md) (product surface and UI).

Plan of record: _Gauzy ↔ Ever Works integration plan_ (2026-10-15), private `ever-co/homelab` repo,
`docs/superpowers/specs/2026-10-15-gauzy-ever-works-integration/` — README (decisions D1–D12), 03 Part B (this
contract, source of truth), 07 (Ever Works work items).

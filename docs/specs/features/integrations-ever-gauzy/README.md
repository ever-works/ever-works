# Ever Gauzy integration — product surface (Ever Works side)

What an Ever Works user sees and does to connect their Ever Works tenant to **Ever Gauzy**: the integration-key dialog
with an "Ever Gauzy" preset, an "Ever Gauzy" card under Settings → Integrations, and the Webhooks page. The sync engine
itself lives in Gauzy (`packages/plugins/integration-ever-works` in `ever-co/ever-gauzy`); Ever Works provides the
platform pieces it needs.

- [spec.md](./spec.md) — feature specification
- [plan.md](./plan.md) — implementation plan
- [tasks.md](./tasks.md) — task breakdown

Platform pieces: [`domain-events`](../domain-events/README.md) (EW-P1-1), [`integration-keys`](../integration-keys/README.md)
(EW-P1-2), [`record-visibility`](../record-visibility/README.md) (EW-P1-3),
[`integrations-api-v1`](../integrations-api-v1/README.md) (EW-P1-4 … P4, the contract Gauzy codes against).

Plan of record: _Gauzy ↔ Ever Works integration plan_ (2026-10-15), private `ever-co/homelab` repo,
`docs/superpowers/specs/2026-10-15-gauzy-ever-works-integration/` — README (decisions D1–D12), 01 (domain mapping),
02 (connection), 07 EW-P1-7 (this feature).

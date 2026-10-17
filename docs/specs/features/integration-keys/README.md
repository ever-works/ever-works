# Integration keys and the integration principal (`ew_int_…`)

Scoped, organization-pinned API keys for integrations — first **Ever Gauzy** — and the principal they authenticate as.
Plan item **EW-P1-2**.

- [spec.md](./spec.md) — what an integration key is, who may create it, what it may and may not do
- [plan.md](./plan.md) — how it is built (columns, guards, throttle tier, rotation, audit, attribution)
- [tasks.md](./tasks.md) — task breakdown and status

**Status:** implemented (EW-P1-2). **Owner:** the Ever Works integration lane.

Related specs: [`integrations-api-v1`](../integrations-api-v1/README.md) (the `/api/integrations/v1` contract every
integration route lives in), [`domain-events`](../domain-events/README.md) (the change feed `whoami.feedHead` points
into), [`record-visibility`](../record-visibility/README.md) (EW-P1-3: what an integration may READ across owners, and
the authoritative organization roster act-as will check).

Plan of record: _Gauzy ↔ Ever Works integration plan_ (2026-10-15), private `ever-co/homelab` repo,
`docs/superpowers/specs/2026-10-15-gauzy-ever-works-integration/` — 02 §2–3 (integration key + principal, scope
vocabulary v1), 03 B.1 (common rules), 07 EW-P1-2.

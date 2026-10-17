# Domain events (EW-P1-1)

Durable, typed domain events for Ever Works: a versioned **catalog**, a transactional **outbox** (`domain_events`), a
single-leader **relay** that fans each event out to in-process listeners (EventEmitter2 `domain.<type>`), EW plugins
(new capability `IDomainEventSubscriberPlugin`) and webhooks v2, and the **change feed** read by integrations.

- [spec.md](./spec.md) — feature specification
- [plan.md](./plan.md) — implementation plan
- [tasks.md](./tasks.md) — task breakdown

Consumers of these events: the integration API change feed and webhooks v2
([`integrations-api-v1`](../integrations-api-v1/README.md)), the notification fan-out of
[`event-subscriptions`](../event-subscriptions/README.md) (EW-664), the activity log and future EW plugins.

Plan of record: _Gauzy ↔ Ever Works integration plan_ (2026-10-15), private `ever-co/homelab` repo,
`docs/superpowers/specs/2026-10-15-gauzy-ever-works-integration/` — decision D7, 03 Part A (this feature), 07 EW-P1-1.

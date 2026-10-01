# Notification Channels (EW-663)

Generic `INotificationChannelPlugin` contract covering Discord, Slack, Telegram, WhatsApp and Novu (meta-router) with fan-out + retry + per-channel delivery log.

- [spec.md](./spec.md) — feature specification
- [plan.md](./plan.md) — implementation plan
- [tasks.md](./tasks.md) — task breakdown

Sibling specs in the notifications-v2 umbrella: [`email-providers`](../email-providers/README.md), [`event-subscriptions`](../event-subscriptions/README.md), [`agent-inbox-ui`](../agent-inbox-ui/README.md).

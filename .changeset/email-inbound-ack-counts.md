---
'@ever-works/plugin': minor
---

**Two new optional inbound-email capability members.**

- `IEmailInboundPlugin.inboundAck` (`EmailInboundAckMode`: `'received'` | `'counts'`) lets an inbound plugin choose how the public webhook acknowledges a verified delivery. Absent means `'received'`, so every existing plugin keeps answering `{"received":true}`; a plugin that sets `'counts'` is answered `{"accepted","duplicates","dropped"}` (`EmailInboundAckCounts`) once its signature has passed. Only opt in when the webhook secret is the deployment's own (an `x-adminOnly` setting).
- `IEmailInboundPlugin.inboundAddressPolicy` (`EmailInboundAddressPolicy`: `{ domain, exclusive }`) declares the rules the platform enforces when an address is registered or re-enabled with the plugin: the address must be on `domain` (400; stored lower-cased) and, when `exclusive`, no other account may hold the same mailbox for inbound mail (409). Absent means no rule. It is read from the loaded instance, so it may be a getter over the environment.

The first user of both is `@ever-works/ever-email-router-plugin`.

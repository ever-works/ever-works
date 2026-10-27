---
'@ever-works/plugin': minor
---

**New optional inbound-email capability member.** `IEmailInboundPlugin.inboundAck` (`EmailInboundAckMode`: `'received'` | `'counts'`) lets an inbound plugin choose how the public webhook acknowledges a verified delivery. Absent means `'received'`, so every existing plugin keeps answering `{"received":true}`; a plugin that sets `'counts'` is answered `{"accepted","duplicates","dropped"}` (`EmailInboundAckCounts`) once its signature has passed. Only opt in when the webhook secret is the deployment's own (an `x-adminOnly` setting). The first user is `@ever-works/ever-email-router-plugin`.

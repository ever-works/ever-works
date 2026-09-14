---
'@ever-works/plugin': minor
---

AI provider plugins may now declare `reasoningSupport(modelId)` and `checkCredential(settings)`, both optional. `AiRoutingOptions` gains optional `reasoningEffort` and `scheduleId`, and `FacadeOptions` gains an optional `scheduleId`. Existing plugins and callers compile and behave unchanged.

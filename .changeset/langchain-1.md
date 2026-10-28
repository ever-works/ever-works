---
'@ever-works/plugin': minor
---

**The SDK's LangChain peer ranges move to `@langchain/core` `^1.3.0` and `@langchain/openai` `^1.7.1`** (from `^0.3.80` / `^0.6.17`). The 0.x line depends on zod 3, which has no fix for GHSA-mrhx-c7xc-m3w5. A plugin that installs LangChain itself next to the SDK must move to 1.x.

`AiOperations` sends the same requests as before. It now builds `ChatOpenAICompletions`, so model names that `ChatOpenAI` 1.x would route to the Responses API (`*codex*`, `gpt-5.6`, `gpt-5.x-pro`) still go to `/chat/completions`, the API every OpenAI-compatible provider speaks. Like the zod 4 change, this ships as a minor so published plugins' `^1.x` SDK peer ranges stay valid.

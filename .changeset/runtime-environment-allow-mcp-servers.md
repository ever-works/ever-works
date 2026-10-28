---
'@ever-works/plugin': minor
---

`RuntimeEnvironmentData` gains an optional `allowMcpServers` flag. It is deny-by-default: a consumer grants MCP-server access only on an explicit `true`. The platform does not write it yet, so every Environment still denies. Existing plugins and callers compile and behave unchanged.

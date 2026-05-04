# Claude Managed Agent Plugin

Full pipeline plugin that delegates work generation to Anthropic Claude Managed Agents.

This package is scaffolded for the Ever Works plugin runtime and uses the Managed Agents REST API directly.

Current scope:

- Creates or reuses a Managed Agent
- Creates or reuses a Managed Agents environment
- Starts a session and sends a generation request
- Collects the final `agent.message`
- Parses structured JSON into Ever Works pipeline outputs
- Optionally enriches items with screenshots via the existing screenshot facade

Notes:

- Managed Agents is currently in beta and requires the `managed-agents-2026-04-01` beta header.
- This plugin currently assumes the built-in `agent_toolset_20260401`.
- It intentionally fails fast if the session pauses for a custom tool result or tool confirmation, because those flows need first-class app orchestration outside a simple pipeline plugin.

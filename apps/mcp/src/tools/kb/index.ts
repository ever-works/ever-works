import { KbListTool } from './list.js';
import { KbGetTool } from './get.js';
import { KbCreateTool } from './create.js';
import { KbUpdateTool } from './update.js';
import { KbLockTool } from './lock.js';

/**
 * EW-643 Phase 3 slice 3 — MCP `kb.*` namespace.
 *
 * Works-security lane 3a (2026-10-18): `kb.unlock` is deliberately NOT
 * registered. A lock is how the owner keeps agents off a document, and every
 * caller of this server can be an agent reading hostile content; the unlock
 * route stays available to a person through the API, the web UI and the CLI.
 * Every `kb.*` result is fenced as untrusted data (document bodies are
 * user- and agent-authored text).
 *
 * Aggregated provider array, ready to be folded into the existing
 * `AppModule.providers` so `@rekog/mcp-nest`'s decorator scanner picks
 * up each `@Tool(...)` decorator at bootstrap. Same shape as the
 * existing `PingTool` / `RegisterWorkTool` registration.
 */
export const KB_TOOL_PROVIDERS = [KbListTool, KbGetTool, KbCreateTool, KbUpdateTool, KbLockTool] as const;

export { KbListTool, KbGetTool, KbCreateTool, KbUpdateTool, KbLockTool };

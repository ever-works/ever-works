import { KbListTool } from './list.js';
import { KbGetTool } from './get.js';
import { KbCreateTool } from './create.js';
import { KbUpdateTool } from './update.js';
import { KbLockTool } from './lock.js';
import { KbUnlockTool } from './unlock.js';

/**
 * EW-643 Phase 3 slice 3 — MCP `kb.*` namespace.
 *
 * Aggregated provider array, ready to be folded into the existing
 * `AppModule.providers` so `@rekog/mcp-nest`'s decorator scanner picks
 * up each `@Tool(...)` decorator at bootstrap. Same shape as the
 * existing `PingTool` / `RegisterWorkTool` registration.
 */
export const KB_TOOL_PROVIDERS = [KbListTool, KbGetTool, KbCreateTool, KbUpdateTool, KbLockTool, KbUnlockTool] as const;

export { KbListTool, KbGetTool, KbCreateTool, KbUpdateTool, KbLockTool, KbUnlockTool };

/**
 * Org-wide Memory (Cortex P2) — contract-surface assertions for the new
 * `memory` + `rag` plugin categories and their capability interfaces.
 *
 * Contract-only test — no concrete plugin ships under either category
 * yet (the built-in per-Work KB behavior is unchanged). This spec pins:
 *   1. `memory` and `rag` are in `PLUGIN_CATEGORIES`.
 *   2. `IMemoryPlugin` / `IRagPlugin` are structurally `IPlugin`-shaped.
 *   3. The `isMemoryPlugin` / `isRagPlugin` type guards key off the
 *      capability string a manifest declares.
 *   4. The additions are purely additive — the pre-existing categories
 *      (e.g. `vector-store`, `content-extractor`) are still present.
 */

import { describe, expectTypeOf, it, expect } from 'vitest';
import { PLUGIN_CATEGORIES, type PluginCategory, isPluginCategory } from '../plugin-manifest.types.js';
import { isMemoryPlugin, type IMemoryPlugin, type MemoryScope } from '../capabilities/memory.interface.js';
import { isRagPlugin, type IRagPlugin } from '../capabilities/rag.interface.js';
import type { IPlugin } from '../plugin.interface.js';

describe('memory + rag plugin categories', () => {
	it("'memory' and 'rag' are in PLUGIN_CATEGORIES", () => {
		expectTypeOf<'memory'>().toExtend<PluginCategory>();
		expectTypeOf<'rag'>().toExtend<PluginCategory>();
		expect(PLUGIN_CATEGORIES.includes('memory')).toBe(true);
		expect(PLUGIN_CATEGORIES.includes('rag')).toBe(true);
	});

	it('isPluginCategory accepts the new categories', () => {
		expect(isPluginCategory('memory')).toBe(true);
		expect(isPluginCategory('rag')).toBe(true);
	});

	it('the additions are additive — existing categories still present', () => {
		expect(isPluginCategory('vector-store')).toBe(true);
		expect(isPluginCategory('content-extractor')).toBe(true);
		expect(isPluginCategory('agent-memory' as string)).toBe(false); // capability, not a category
	});
});

describe('IMemoryPlugin — contract surface', () => {
	it('is IPlugin-shaped', () => {
		expectTypeOf<IMemoryPlugin>().toExtend<IPlugin>();
	});

	it('isMemoryPlugin keys off the "memory" capability', () => {
		const memoryish = { capabilities: ['memory'] } as unknown as IPlugin;
		const other = { capabilities: ['vector-store'] } as unknown as IPlugin;
		expect(isMemoryPlugin(memoryish)).toBe(true);
		expect(isMemoryPlugin(other)).toBe(false);
	});

	it('MemoryScope is fully optional (org-aware but tolerant)', () => {
		const scope: MemoryScope = {};
		expect(scope).toBeDefined();
	});
});

describe('IRagPlugin — contract surface', () => {
	it('is IPlugin-shaped', () => {
		expectTypeOf<IRagPlugin>().toExtend<IPlugin>();
	});

	it('isRagPlugin keys off the "rag" capability', () => {
		const ragish = { capabilities: ['rag'] } as unknown as IPlugin;
		const other = { capabilities: ['search'] } as unknown as IPlugin;
		expect(isRagPlugin(ragish)).toBe(true);
		expect(isRagPlugin(other)).toBe(false);
	});
});

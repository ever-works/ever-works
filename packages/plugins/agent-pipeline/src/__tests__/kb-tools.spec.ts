import { describe, it, expect, vi } from 'vitest';
import {
	createKbSearchTool,
	createKbReadTool,
	createKbWriteTool,
	createKbLockTool,
	createKbUnlockTool,
	createKbTools,
	type IKbToolsFacade,
	type KbToolBuilderContext
} from '../tools/kb-tools';
import type { PluginLogger } from '@ever-works/plugin';

function createMockLogger(): PluginLogger {
	return { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function createMockFacade(overrides: Partial<IKbToolsFacade> = {}): IKbToolsFacade {
	return {
		kbSearch: vi.fn().mockResolvedValue({ ok: true, data: { items: [], total: 0 } }),
		kbRead: vi.fn().mockResolvedValue({ ok: true, data: {} }),
		kbWrite: vi.fn().mockResolvedValue({ ok: true, data: { document: {}, action: 'created' as const } }),
		kbLock: vi.fn().mockResolvedValue({ ok: true, data: {} }),
		kbUnlock: vi.fn().mockResolvedValue({ ok: true, data: {} }),
		...overrides
	};
}

function createCtx(overrides: Partial<KbToolBuilderContext> = {}): KbToolBuilderContext {
	return {
		workId: 'work-1',
		userId: 'user-1',
		facade: createMockFacade(),
		logger: createMockLogger(),
		...overrides
	};
}

const toolCallCtx = { toolCallId: 'call_1', messages: [] } as never;

describe('kb-tools (row 36b)', () => {
	describe('createKbSearchTool', () => {
		it('forwards inputs to facade.kbSearch with bound workId / userId', async () => {
			const facade = createMockFacade();
			const tool = createKbSearchTool(createCtx({ facade }));

			const result = await tool.execute!({ q: 'voice', class: 'brand', limit: 5 }, toolCallCtx);

			expect(facade.kbSearch).toHaveBeenCalledWith('work-1', 'user-1', {
				q: 'voice',
				class: 'brand',
				limit: 5
			});
			expect(result).toEqual({ ok: true, data: { items: [], total: 0 } });
		});

		it('returns { ok: false } on facade throw without bubbling the exception', async () => {
			const facade = createMockFacade({
				kbSearch: vi.fn().mockRejectedValue(new Error('boom'))
			});
			const logger = createMockLogger();
			const tool = createKbSearchTool(createCtx({ facade, logger }));

			const result = await tool.execute!({}, toolCallCtx);
			expect(result).toEqual({ ok: false, error: 'boom' });
			expect(logger.warn).toHaveBeenCalled();
		});
	});

	describe('createKbReadTool', () => {
		it('passes idOrPath through to facade.kbRead', async () => {
			const facade = createMockFacade();
			const tool = createKbReadTool(createCtx({ facade }));

			await tool.execute!({ idOrPath: 'brand/voice.md' }, toolCallCtx);

			expect(facade.kbRead).toHaveBeenCalledWith('work-1', 'user-1', 'brand/voice.md');
		});

		it('surfaces facade error as ok:false', async () => {
			const facade = createMockFacade({
				kbRead: vi.fn().mockResolvedValue({ ok: false, error: 'not found' })
			});
			const tool = createKbReadTool(createCtx({ facade }));

			const result = await tool.execute!({ idOrPath: 'ghost' }, toolCallCtx);
			expect(result).toEqual({ ok: false, error: 'not found' });
		});
	});

	describe('createKbWriteTool', () => {
		it('threads generatedByAgentRunId into the upsert payload', async () => {
			const facade = createMockFacade();
			const tool = createKbWriteTool(createCtx({ facade }), 'run-99');

			await tool.execute!(
				{
					path: 'brand/manifesto.md',
					title: 'Brand Manifesto',
					class: 'brand',
					body: 'hello'
				},
				toolCallCtx
			);

			expect(facade.kbWrite).toHaveBeenCalledWith(
				'work-1',
				'user-1',
				expect.objectContaining({
					path: 'brand/manifesto.md',
					title: 'Brand Manifesto',
					class: 'brand',
					body: 'hello',
					generatedByAgentRunId: 'run-99'
				})
			);
		});

		it('omits generatedByAgentRunId when not provided', async () => {
			const facade = createMockFacade();
			const tool = createKbWriteTool(createCtx({ facade }));

			await tool.execute!(
				{
					path: 'brand/voice.md',
					title: 'Brand Voice',
					class: 'brand',
					body: 'hi'
				},
				toolCallCtx
			);

			expect(facade.kbWrite).toHaveBeenCalledWith(
				'work-1',
				'user-1',
				expect.objectContaining({
					generatedByAgentRunId: undefined
				})
			);
		});
	});

	describe('createKbLockTool', () => {
		it('forwards docId + mode to facade.kbLock', async () => {
			const facade = createMockFacade();
			const tool = createKbLockTool(createCtx({ facade }));

			await tool.execute!({ docId: 'd1', mode: 'full' }, toolCallCtx);

			expect(facade.kbLock).toHaveBeenCalledWith('work-1', 'user-1', 'd1', 'full');
		});
	});

	describe('createKbUnlockTool', () => {
		it('forwards docId to facade.kbUnlock', async () => {
			const facade = createMockFacade();
			const tool = createKbUnlockTool(createCtx({ facade }));

			await tool.execute!({ docId: 'd1' }, toolCallCtx);

			expect(facade.kbUnlock).toHaveBeenCalledWith('work-1', 'user-1', 'd1');
		});
	});

	describe('createKbTools aggregator', () => {
		it('returns all five tools keyed by canonical kb_* names', () => {
			const tools = createKbTools(createCtx());
			expect(Object.keys(tools).sort()).toEqual(['kb_lock', 'kb_read', 'kb_search', 'kb_unlock', 'kb_write']);
		});

		it('passes generatedByAgentRunId through to the kb_write tool only', async () => {
			const facade = createMockFacade();
			const tools = createKbTools(createCtx({ facade }), 'run-42');

			await tools.kb_write.execute!(
				{
					path: 'brand/x.md',
					title: 'x',
					class: 'brand',
					body: 'b'
				},
				toolCallCtx
			);

			expect(facade.kbWrite).toHaveBeenCalledWith(
				'work-1',
				'user-1',
				expect.objectContaining({ generatedByAgentRunId: 'run-42' })
			);

			// The other tools don't have a generatedByAgentRunId slot — confirm
			// they exist and invoke their facade methods correctly.
			await tools.kb_search.execute!({ q: 'foo' }, toolCallCtx);
			expect(facade.kbSearch).toHaveBeenCalled();
		});
	});
});

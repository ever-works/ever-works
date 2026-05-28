import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	MemoryPipelineModifierPlugin,
	FETCH_CONTEXT_STEP_ID,
	SAVE_MEMORY_STEP_ID
} from '../memory-pipeline-modifier.plugin.js';
import type { StepExecutionContext, IAgentMemoryStepFacade, IPipelineContext } from '@ever-works/plugin';

describe('MemoryPipelineModifierPlugin', () => {
	let plugin: MemoryPipelineModifierPlugin;
	let memoryFacade: IAgentMemoryStepFacade;
	let logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		plugin = new MemoryPipelineModifierPlugin();
		logger = { log: vi.fn(), warn: vi.fn() };
		memoryFacade = {
			openSession: vi.fn(),
			closeSession: vi.fn(),
			saveMemory: vi.fn(),
			searchMemory: vi.fn(),
			buildContext: vi.fn(),
			deleteEntry: vi.fn(),
			listSessions: vi.fn(),
			isConfigured: vi.fn().mockReturnValue(true)
		} as unknown as IAgentMemoryStepFacade;
	});

	function makeContext(overrides?: Partial<Record<string, unknown>>): IPipelineContext {
		return {
			work: { id: 'work-1', slug: 'best-react-tools', name: 'Best React Tools', user: { id: 'u-1' } },
			request: { prompt: 'Top 10 React UI libraries' },
			items: [{ name: 'Item A' }, { name: 'Item B' }],
			...overrides
		} as unknown as IPipelineContext;
	}

	function makeExecContext(): StepExecutionContext {
		return {
			agentMemoryFacade: memoryFacade,
			logger,
			work: { id: 'work-1', slug: 'best-react-tools', name: 'Best React Tools', user: { id: 'u-1' } }
		} as unknown as StepExecutionContext;
	}

	describe('metadata', () => {
		it('declares the pipeline-modifier capability', () => {
			expect(plugin.id).toBe('memory-pipeline-modifier');
			expect(plugin.capabilities).toContain('pipeline-modifier');
		});

		it('targets all pipelines (["*"])', () => {
			expect(plugin.targetPipelines).toEqual(['*']);
		});

		it('declares two injected steps at first + last positions', () => {
			const defs = plugin.getStepDefinitions();
			expect(defs).toHaveLength(2);
			const fetch = defs.find((d) => d.id === FETCH_CONTEXT_STEP_ID);
			const save = defs.find((d) => d.id === SAVE_MEMORY_STEP_ID);
			expect(fetch?.position).toEqual({ type: 'first' });
			expect(save?.position).toEqual({ type: 'last' });
		});

		it('settings schema defaults `enabled` to false (opt-in)', () => {
			const enabled = (plugin.settingsSchema.properties?.enabled ?? {}) as Record<string, unknown>;
			expect(enabled.default).toBe(false);
			expect(enabled['x-scope']).toBe('work');
		});
	});

	describe('canSkip', () => {
		it('returns true when settings.enabled !== true (default off)', async () => {
			await expect(plugin.canSkip(makeContext())).resolves.toBe(true);
		});

		it('returns false when stepSettings.enabled === true', async () => {
			const context = makeContext({
				stepSettings: { 'memory-pipeline-modifier': { enabled: true } }
			});
			await expect(plugin.canSkip(context)).resolves.toBe(false);
		});
	});

	describe('execute — dispatch', () => {
		it('throws if stepId is missing (would be a wiring bug)', async () => {
			await expect(
				plugin.execute(makeContext(), { settings: { execContext: makeExecContext() } })
			).rejects.toThrow(/stepId.*required/);
		});

		it('throws for an unknown stepId', async () => {
			await expect(
				plugin.execute(makeContext(), {
					settings: { stepId: 'bogus', execContext: makeExecContext() }
				})
			).rejects.toThrow(/unknown stepId/);
		});

		it('no-ops gracefully when no agentMemoryFacade is on execContext', async () => {
			const execContext = { logger } as unknown as StepExecutionContext;
			await plugin.execute(makeContext(), {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext }
			});
			expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no agent-memory facade/));
		});
	});

	describe('memory-fetch-context step', () => {
		it('calls buildContext with project, purpose, prompt, maxTokens — and attaches result to context.memoryContext', async () => {
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				content: 'prior memory text',
				approxTokens: 250
			});
			const context = makeContext();
			await plugin.execute(context, {
				settings: {
					stepId: FETCH_CONTEXT_STEP_ID,
					execContext: makeExecContext(),
					purpose: 'fix-bug',
					maxContextTokens: 1000
				}
			});
			expect(memoryFacade.buildContext).toHaveBeenCalledWith(
				expect.objectContaining({
					query: 'Top 10 React UI libraries',
					purpose: 'fix-bug',
					projectId: 'best-react-tools',
					maxTokens: 1000
				}),
				expect.any(Object)
			);
			expect((context as unknown as { memoryContext?: unknown }).memoryContext).toEqual({
				content: 'prior memory text',
				approxTokens: 250
			});
		});

		it('logs when no prior memory is found (empty content)', async () => {
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ content: '' });
			await plugin.execute(makeContext(), {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
			});
			expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/no prior memory/));
		});

		it('catches errors and never crashes the host pipeline', async () => {
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new Error('connection refused')
			);
			const context = makeContext();
			await expect(
				plugin.execute(context, {
					settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
				})
			).resolves.toBeDefined();
			expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/connection refused/));
		});
	});

	describe('memory-save step', () => {
		it('calls saveMemory with a digest mentioning the Work + item count', async () => {
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				id: 'mem-1',
				createdAt: 'now',
				content: 'x'
			});
			await plugin.execute(makeContext(), {
				settings: { stepId: SAVE_MEMORY_STEP_ID, execContext: makeExecContext() }
			});
			expect(memoryFacade.saveMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.stringMatching(/Best React Tools.*2 items/),
					projectId: 'best-react-tools',
					tags: expect.arrayContaining(['pipeline-run', 'work:best-react-tools'])
				}),
				expect.any(Object)
			);
		});

		it('marks tags as `failed` when the pipeline context has an errorMessage', async () => {
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				id: 'mem-1',
				createdAt: 'now',
				content: 'x'
			});
			const context = makeContext({ errorMessage: 'AI provider rate-limited' });
			await plugin.execute(context, {
				settings: { stepId: SAVE_MEMORY_STEP_ID, execContext: makeExecContext() }
			});
			expect(memoryFacade.saveMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					tags: expect.arrayContaining(['failed']),
					content: expect.stringMatching(/rate-limited/)
				}),
				expect.any(Object)
			);
		});

		it('marks tags as `cancelled` when the context has a cancellationError', async () => {
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				id: 'mem-1',
				createdAt: 'now',
				content: 'x'
			});
			const context = makeContext({ cancellationError: { code: 'user-cancel' } });
			await plugin.execute(context, {
				settings: { stepId: SAVE_MEMORY_STEP_ID, execContext: makeExecContext() }
			});
			expect(memoryFacade.saveMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					tags: expect.arrayContaining(['cancelled']),
					content: expect.stringMatching(/cancelled.*user-cancel/)
				}),
				expect.any(Object)
			);
		});

		it('skips entirely when stepSettings.saveSummary === false', async () => {
			const context = makeContext({
				stepSettings: { 'memory-pipeline-modifier': { saveSummary: false } }
			});
			await plugin.execute(context, {
				settings: { stepId: SAVE_MEMORY_STEP_ID, execContext: makeExecContext() }
			});
			expect(memoryFacade.saveMemory).not.toHaveBeenCalled();
			expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/saveSummary disabled/));
		});

		it('catches errors and never crashes the host pipeline', async () => {
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('agentmemory down'));
			await expect(
				plugin.execute(makeContext(), {
					settings: { stepId: SAVE_MEMORY_STEP_ID, execContext: makeExecContext() }
				})
			).resolves.toBeDefined();
			expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/agentmemory down/));
		});
	});

	describe('lifecycle + validation', () => {
		it('reports healthy', async () => {
			const health = await plugin.healthCheck();
			expect(health.status).toBe('healthy');
		});

		it('rejects out-of-range maxContextTokens', async () => {
			const result = await plugin.validateSettings({ maxContextTokens: 50 });
			expect(result.valid).toBe(false);
			expect(result.errors?.[0].path).toBe('maxContextTokens');
		});
	});
});

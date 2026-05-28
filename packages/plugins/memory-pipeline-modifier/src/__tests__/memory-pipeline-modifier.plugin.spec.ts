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

	// stepSettings.enabled MUST be true for execute() to actually do
	// work — `canSkip()` is informational today (Codex P2 on PR #1081
	// — the pipeline builder doesn't call it yet), so the gate lives
	// inside `execute()`. Each test that exercises a step path passes
	// `enabled: true` here.
	function makeContext(overrides?: Partial<Record<string, unknown>>, enabled = true): IPipelineContext {
		const base: Record<string, unknown> = {
			work: { id: 'work-1', slug: 'best-react-tools', name: 'Best React Tools', user: { id: 'u-1' } },
			request: { prompt: 'Top 10 React UI libraries' },
			items: [{ name: 'Item A' }, { name: 'Item B' }],
			...overrides
		};
		if (enabled) {
			base.stepSettings = {
				...((overrides?.stepSettings as Record<string, unknown> | undefined) ?? {}),
				'memory-pipeline-modifier': {
					enabled: true,
					...(((overrides?.stepSettings as Record<string, unknown> | undefined)?.[
						'memory-pipeline-modifier'
					] as Record<string, unknown>) ?? {})
				}
			};
		}
		return base as unknown as IPipelineContext;
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

		it('targets ONLY step-orchestratable pipelines (standard + agent), not the wildcard', () => {
			// Self-managed pipelines (claude-code, codex, opencode) bypass
			// modifier injection — Codex P2 on PR #1081.
			expect([...plugin.targetPipelines]).toEqual(['standard-pipeline', 'agent-pipeline']);
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
			await expect(plugin.canSkip(makeContext({}, false))).resolves.toBe(true);
		});

		it('returns false when stepSettings.enabled === true', async () => {
			await expect(plugin.canSkip(makeContext())).resolves.toBe(false);
		});
	});

	describe('enabled gate inside execute()', () => {
		it('no-ops when stepSettings.enabled !== true (since pipeline builder may not call canSkip)', async () => {
			const context = makeContext({}, false);
			await plugin.execute(context, {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
			});
			expect(memoryFacade.buildContext).not.toHaveBeenCalled();
			expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/disabled by settings/));
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
			const context = makeContext({
				stepSettings: {
					'memory-pipeline-modifier': { enabled: true, purpose: 'fix-bug', maxContextTokens: 1000 }
				}
			});
			await plugin.execute(context, {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
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
			await expect(
				plugin.execute(makeContext(), {
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

		it('skips entirely when stepSettings.saveSummary === false', async () => {
			const context = makeContext({
				stepSettings: {
					'memory-pipeline-modifier': { enabled: true, saveSummary: false }
				}
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

	describe('rollback() hook (failure / cancellation capture)', () => {
		async function primeStashedExecContext(): Promise<ReturnType<typeof makeContext>> {
			// rollback reads execContext from the context bag; populate it
			// by running the fetch-context step first (the executor runs
			// modifier steps in pipeline order, so by the time rollback
			// fires fetch-context has already stashed the facade).
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ content: '' });
			const context = makeContext();
			await plugin.execute(context, {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
			});
			return context;
		}

		it('persists a `failed` observation when the pipeline throws', async () => {
			const context = await primeStashedExecContext();
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				id: 'mem-1',
				createdAt: 'now',
				content: 'x'
			});
			await plugin.rollback(context, new Error('AI provider rate-limited'));
			expect(memoryFacade.saveMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.stringMatching(/failed.*rate-limited/),
					tags: expect.arrayContaining(['pipeline-run', 'failed', 'work:best-react-tools'])
				}),
				expect.any(Object)
			);
		});

		it('marks a cancellation distinctly from a failure', async () => {
			const context = await primeStashedExecContext();
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				id: 'mem-1',
				createdAt: 'now',
				content: 'x'
			});
			await plugin.rollback(context, new Error('Pipeline cancelled at step: foo'));
			expect(memoryFacade.saveMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.stringMatching(/cancelled/),
					tags: expect.arrayContaining(['cancelled'])
				}),
				expect.any(Object)
			);
		});

		it('recognises AbortError as a cancellation', async () => {
			const context = await primeStashedExecContext();
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				id: 'mem-1',
				createdAt: 'now',
				content: 'x'
			});
			const abortError = new Error('some abort message');
			abortError.name = 'AbortError';
			await plugin.rollback(context, abortError);
			expect(memoryFacade.saveMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					tags: expect.arrayContaining(['cancelled'])
				}),
				expect.any(Object)
			);
		});

		it('no-ops silently when fetch-context never stashed an execContext', async () => {
			// Skip the priming step — the pipeline failed before our
			// fetch ran, so nothing is stashed. rollback should swallow.
			const context = makeContext();
			await plugin.rollback(context, new Error('boom'));
			expect(memoryFacade.saveMemory).not.toHaveBeenCalled();
		});

		it('no-ops when the modifier is disabled (enabled !== true)', async () => {
			await primeStashedExecContext();
			const context = makeContext({}, false);
			// Even though execContext is stashable from the priming run,
			// settings.enabled is false, so rollback should not call save.
			(context as Record<string, unknown>).__memoryModifierExecContext = makeExecContext();
			vi.clearAllMocks();
			await plugin.rollback(context, new Error('boom'));
			expect(memoryFacade.saveMemory).not.toHaveBeenCalled();
		});

		it('no-ops when saveSummary === false (operator opted out of post-run saves)', async () => {
			const context = makeContext({
				stepSettings: {
					'memory-pipeline-modifier': { enabled: true, saveSummary: false }
				}
			});
			(context as Record<string, unknown>).__memoryModifierExecContext = makeExecContext();
			await plugin.rollback(context, new Error('boom'));
			expect(memoryFacade.saveMemory).not.toHaveBeenCalled();
		});

		it("swallows saveMemory errors so the executor isn't derailed", async () => {
			const context = await primeStashedExecContext();
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new Error('agentmemory unreachable')
			);
			await expect(plugin.rollback(context, new Error('original failure'))).resolves.toBeUndefined();
			expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/agentmemory unreachable/));
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

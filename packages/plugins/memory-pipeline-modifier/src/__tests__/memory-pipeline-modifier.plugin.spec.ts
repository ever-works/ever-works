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

	describe("defensive enabled guard inside execute() (host doesn't honour canSkipAtBuildTime)", () => {
		it('silently no-ops when stepSettings.enabled !== true', async () => {
			// PR #1087 makes canSkipAtBuildTime the canonical gate, but
			// we keep this guard for older agent builds / third-party
			// orchestrators that don't call it.
			const context = makeContext({}, false);
			await plugin.execute(context, {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
			});
			expect(memoryFacade.buildContext).not.toHaveBeenCalled();
		});
	});

	describe('canSkipAtBuildTime (KB option B, PR #1087)', () => {
		it('returns true when settings.enabled is missing (default off)', async () => {
			await expect(plugin.canSkipAtBuildTime({ settings: {}, pipelineId: 'standard-pipeline' })).resolves.toBe(
				true
			);
		});

		it('returns true when settings.enabled === false', async () => {
			await expect(
				plugin.canSkipAtBuildTime({
					settings: { enabled: false },
					pipelineId: 'standard-pipeline'
				})
			).resolves.toBe(true);
		});

		it('returns false when settings.enabled === true (work opts in)', async () => {
			await expect(
				plugin.canSkipAtBuildTime({
					settings: { enabled: true },
					pipelineId: 'standard-pipeline',
					workId: 'work-1',
					userId: 'u-1'
				})
			).resolves.toBe(false);
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

	// Item #18 — `memorySessionId` plumbing from the orchestrator
	// (e.g. AgentRunService) through StepExecutionContext into the
	// modifier's buildContext / saveMemory / rollback paths.
	describe('memorySessionId propagation from execContext', () => {
		function makeExecContextWithSession(sessionId?: string): StepExecutionContext {
			return {
				agentMemoryFacade: memoryFacade,
				logger,
				work: { id: 'work-1', slug: 'best-react-tools', name: 'Best React Tools', user: { id: 'u-1' } },
				...(sessionId ? { memorySessionId: sessionId } : {})
			} as unknown as StepExecutionContext;
		}

		it('threads execContext.memorySessionId into buildContext on the fetch step', async () => {
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValue({
				content: 'prior notes',
				approxTokens: 42
			});
			const context = makeContext();
			await plugin.execute(context, {
				settings: {
					stepId: FETCH_CONTEXT_STEP_ID,
					execContext: makeExecContextWithSession('sess-orchestrator-1')
				}
			});
			expect(memoryFacade.buildContext).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'sess-orchestrator-1' }),
				expect.anything()
			);
		});

		it('omits sessionId from buildContext when execContext does not carry one', async () => {
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValue({
				content: 'prior notes',
				approxTokens: 42
			});
			const context = makeContext();
			await plugin.execute(context, {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContextWithSession() }
			});
			const buildArg = (memoryFacade.buildContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(buildArg).not.toHaveProperty('sessionId');
		});

		it('threads execContext.memorySessionId into saveMemory on the save step', async () => {
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'mem-1' });
			const context = makeContext();
			// Prime the stash so the save step's lookup works.
			(context as Record<string, unknown>).__memoryModifierExecContext =
				makeExecContextWithSession('sess-orchestrator-2');
			await plugin.execute(context, {
				settings: {
					stepId: SAVE_MEMORY_STEP_ID,
					execContext: makeExecContextWithSession('sess-orchestrator-2')
				}
			});
			expect(memoryFacade.saveMemory).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'sess-orchestrator-2' }),
				expect.anything()
			);
		});

		it('threads execContext.memorySessionId into rollback saveMemory', async () => {
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'mem-rb-1' });
			const context = makeContext();
			(context as Record<string, unknown>).__memoryModifierExecContext =
				makeExecContextWithSession('sess-orchestrator-3');
			await plugin.rollback(context, new Error('boom'));
			expect(memoryFacade.saveMemory).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'sess-orchestrator-3' }),
				expect.anything()
			);
		});

		it('opens a per-run session on fetch when none supplied and threads it into buildContext', async () => {
			(memoryFacade.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: 'sess-self-1',
				startedAt: 'now'
			});
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValue({ content: 'x' });
			const context = makeContext();
			await plugin.execute(context, {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
			});
			expect(memoryFacade.openSession).toHaveBeenCalledTimes(1);
			expect(memoryFacade.buildContext).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'sess-self-1' }),
				expect.anything()
			);
			expect((context as Record<string, unknown>).__memoryModifierSessionId).toBe('sess-self-1');
		});

		it('reuses the self-opened session on save (no second open) and closes it once', async () => {
			(memoryFacade.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: 'sess-self-2',
				startedAt: 'now'
			});
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValue({ content: '' });
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'mem-2' });
			const context = makeContext();
			await plugin.execute(context, {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
			});
			await plugin.execute(context, {
				settings: { stepId: SAVE_MEMORY_STEP_ID, execContext: makeExecContext() }
			});
			expect(memoryFacade.openSession).toHaveBeenCalledTimes(1);
			expect(memoryFacade.saveMemory).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'sess-self-2' }),
				expect.anything()
			);
			expect(memoryFacade.closeSession).toHaveBeenCalledTimes(1);
			expect(memoryFacade.closeSession).toHaveBeenCalledWith('sess-self-2', expect.anything());
		});

		it('closes the self-opened session even when saveSummary is disabled', async () => {
			(memoryFacade.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: 'sess-self-3',
				startedAt: 'now'
			});
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValue({ content: '' });
			const context = makeContext({
				stepSettings: { 'memory-pipeline-modifier': { enabled: true, saveSummary: false } }
			});
			await plugin.execute(context, {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
			});
			await plugin.execute(context, {
				settings: { stepId: SAVE_MEMORY_STEP_ID, execContext: makeExecContext() }
			});
			expect(memoryFacade.saveMemory).not.toHaveBeenCalled();
			expect(memoryFacade.closeSession).toHaveBeenCalledWith('sess-self-3', expect.anything());
		});

		it('closes the self-opened session via rollback on failure', async () => {
			(memoryFacade.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: 'sess-self-4',
				startedAt: 'now'
			});
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValue({ content: '' });
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'mem-rb' });
			const context = makeContext();
			await plugin.execute(context, {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
			});
			await plugin.rollback(context, new Error('boom'));
			expect(memoryFacade.saveMemory).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'sess-self-4' }),
				expect.anything()
			);
			expect(memoryFacade.closeSession).toHaveBeenCalledWith('sess-self-4', expect.anything());
		});

		it('closes the self-opened session on rollback even when saveSummary is disabled', async () => {
			(memoryFacade.openSession as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: 'sess-self-5',
				startedAt: 'now'
			});
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValue({ content: '' });
			const context = makeContext({
				stepSettings: { 'memory-pipeline-modifier': { enabled: true, saveSummary: false } }
			});
			await plugin.execute(context, {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
			});
			await plugin.rollback(context, new Error('boom'));
			// saveSummary off → no failure digest persisted, but the session
			// we opened in fetch-context must still be closed.
			expect(memoryFacade.saveMemory).not.toHaveBeenCalled();
			expect(memoryFacade.closeSession).toHaveBeenCalledWith('sess-self-5', expect.anything());
		});

		it('does NOT open or close a session when the orchestrator supplies one', async () => {
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValue({ content: '' });
			(memoryFacade.saveMemory as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'mem-o' });
			const context = makeContext();
			await plugin.execute(context, {
				settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContextWithSession('sess-orch') }
			});
			await plugin.execute(context, {
				settings: { stepId: SAVE_MEMORY_STEP_ID, execContext: makeExecContextWithSession('sess-orch') }
			});
			expect(memoryFacade.openSession).not.toHaveBeenCalled();
			expect(memoryFacade.closeSession).not.toHaveBeenCalled();
			expect(memoryFacade.saveMemory).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'sess-orch' }),
				expect.anything()
			);
		});

		it('swallows a session-open failure and continues session-less', async () => {
			(memoryFacade.openSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('session server down'));
			(memoryFacade.buildContext as ReturnType<typeof vi.fn>).mockResolvedValue({ content: 'x' });
			const context = makeContext();
			await expect(
				plugin.execute(context, {
					settings: { stepId: FETCH_CONTEXT_STEP_ID, execContext: makeExecContext() }
				})
			).resolves.toBeDefined();
			expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/failed to open session/));
			const buildArg = (memoryFacade.buildContext as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(buildArg).not.toHaveProperty('sessionId');
		});
	});
});

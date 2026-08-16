import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the whole SDK: the plugin only ever talks to `client.beta.*` through
// AnthropicManagedAgentsClient, so every resource method is a controllable fn.
const sdkMocks = vi.hoisted(() => ({
	agentsList: vi.fn(),
	agentsCreate: vi.fn(),
	agentsUpdate: vi.fn(),
	agentsRetrieve: vi.fn(),
	agentsArchive: vi.fn(),
	environmentsCreate: vi.fn(),
	environmentsUpdate: vi.fn(),
	environmentsRetrieve: vi.fn(),
	environmentsDelete: vi.fn(),
	sessionsCreate: vi.fn(),
	sessionsDelete: vi.fn(),
	sessionsArchive: vi.fn(),
	sessionsRetrieve: vi.fn(),
	eventsSend: vi.fn(),
	eventsList: vi.fn(),
	filesUpload: vi.fn(),
	filesDelete: vi.fn()
}));

vi.mock('@anthropic-ai/sdk', () => {
	class AnthropicMock {
		beta = {
			agents: {
				list: sdkMocks.agentsList,
				create: sdkMocks.agentsCreate,
				update: sdkMocks.agentsUpdate,
				retrieve: sdkMocks.agentsRetrieve,
				archive: sdkMocks.agentsArchive
			},
			environments: {
				create: sdkMocks.environmentsCreate,
				update: sdkMocks.environmentsUpdate,
				retrieve: sdkMocks.environmentsRetrieve,
				delete: sdkMocks.environmentsDelete
			},
			sessions: {
				create: sdkMocks.sessionsCreate,
				delete: sdkMocks.sessionsDelete,
				archive: sdkMocks.sessionsArchive,
				retrieve: sdkMocks.sessionsRetrieve,
				events: { send: sdkMocks.eventsSend, list: sdkMocks.eventsList }
			},
			files: { upload: sdkMocks.filesUpload, delete: sdkMocks.filesDelete }
		};
		constructor(_opts: unknown) {
			void _opts;
		}
	}

	return {
		default: AnthropicMock,
		toFile: vi.fn(async (buf: Buffer, name: string) => ({ buf, name }))
	};
});

import { ClaudeManagedAgentPlugin } from './claude-managed-agent.plugin.js';
import { CMA_FAN_OUT_CAPABILITY, type ManagedAgentPipelineMetrics } from './types.js';

/**
 * Faithful replica of the platform's `extractPipelineUsageMetrics`
 * (`packages/agent/src/utils/metrics.util.ts`) — plugin packages cannot import
 * `@ever-works/agent`, so the consumer contract is asserted here instead.
 * Tokens come from `tokenUsage.total.totalTokens` or the per-step
 * `custom.totalTokens` sum; cost from `totalCost` (only when > 0) or the
 * per-step `custom.totalCost` sum. Nothing else is read.
 */
function extractUsageLikePlatform(metrics: ManagedAgentPipelineMetrics | undefined) {
	if (!metrics) {
		return {};
	}

	const steps = Object.values(metrics.steps ?? {}) as Array<{ custom?: Record<string, unknown> }>;
	const stepNumber = (key: 'totalTokens' | 'totalCost') =>
		steps.reduce(
			(sum, step) => sum + (typeof step.custom?.[key] === 'number' ? (step.custom[key] as number) : 0),
			0
		);

	const explicitTokens = metrics.tokenUsage?.total?.totalTokens;
	const explicitCost = metrics.totalCost;
	const totalTokens = typeof explicitTokens === 'number' ? explicitTokens : stepNumber('totalTokens');
	const totalCost = typeof explicitCost === 'number' && explicitCost > 0 ? explicitCost : stepNumber('totalCost');

	return {
		...(totalTokens > 0 ? { total_tokens_used: totalTokens } : {}),
		...(totalCost > 0 ? { total_cost: totalCost } : {})
	};
}

const FINAL_JSON = (itemName: string, sourceUrl = 'https://example.com') =>
	JSON.stringify({
		items: [
			{
				name: itemName,
				description: `${itemName} description`,
				source_url: sourceUrl,
				category: ['Tools'],
				tags: ['tag-one']
			}
		],
		categories: [{ name: 'Tools' }],
		tags: [{ name: 'tag-one' }],
		collections: [],
		brands: [],
		operations: { created_files: [`${itemName}.json`], updated_files: [], unchanged_seeded_files_count: 0 },
		warnings: []
	});

function asyncIterableOf(events: unknown[]): AsyncIterable<unknown> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event;
			}
		}
	};
}

function agentMessage(id: string, text: string) {
	return { id, type: 'agent.message', content: [{ type: 'text', text }] };
}

function idleEvent(id: string) {
	return { id, type: 'session.status_idle', stop_reason: { type: 'end_turn' } };
}

const WORK = { id: 'work-1', name: 'My Work', slug: 'my-work', description: 'A test work' };
const EXISTING = { items: [], categories: [], tags: [], collections: [], brands: [] };

function createContextStub(userSettings: Record<string, unknown>) {
	const updateSettings = vi.fn().mockResolvedValue(undefined);
	const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const registry = new Map<string, unknown>();
	const registerCustomCapability = vi.fn((definition: { name: string }, implementation: unknown) => {
		if (registry.has(definition.name)) {
			throw new Error(`Capability "${definition.name}" is already registered`);
		}
		registry.set(definition.name, implementation);
	});
	const hasCustomCapability = vi.fn((name: string) => registry.has(name));

	return {
		context: {
			pluginId: 'claude-managed-agent',
			logger,
			getSettings: vi.fn(async (scope: string) => (scope === 'user' ? userSettings : {})),
			updateSettings,
			registerCustomCapability,
			hasCustomCapability,
			getCustomCapability: vi.fn((name: string) => registry.get(name))
		} as never,
		updateSettings,
		registerCustomCapability,
		registry,
		logger
	};
}

function execOptions() {
	return {
		execContext: {
			user: { id: 'user-1' },
			work: WORK,
			logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
		} as never
	};
}

/**
 * Configure the SDK mocks for a happy-path run:
 * sessions immediately idle, three event listings per session
 * (seed / generation / final) driven by call order.
 */
function primeSingleSessionRun() {
	sdkMocks.filesUpload.mockResolvedValue({ id: 'file_1' });
	sdkMocks.filesDelete.mockResolvedValue({});
	sdkMocks.agentsCreate.mockResolvedValue({ id: 'agent_1' });
	sdkMocks.agentsArchive.mockResolvedValue({});
	sdkMocks.environmentsCreate.mockResolvedValue({ id: 'env_1' });
	sdkMocks.environmentsDelete.mockResolvedValue({});
	sdkMocks.sessionsCreate.mockResolvedValue({ id: 'session_1', status: 'running' });
	sdkMocks.sessionsRetrieve.mockResolvedValue({
		id: 'session_1',
		status: 'idle',
		usage: { input_tokens: 120, output_tokens: 80, list_cost: { amount: '250', currency: 'USD' } }
	});
	sdkMocks.sessionsDelete.mockResolvedValue({});
	sdkMocks.sessionsArchive.mockResolvedValue({});
	sdkMocks.eventsSend.mockResolvedValue({});

	const seedEvents = [agentMessage('e1', 'WORKSPACE_READY'), idleEvent('e2')];
	const generationEvents = [...seedEvents, agentMessage('e3', 'working on it'), idleEvent('e4')];
	const finalEvents = [...generationEvents, agentMessage('e5', FINAL_JSON('Alpha Tool')), idleEvent('e6')];
	sdkMocks.eventsList
		.mockReturnValueOnce(asyncIterableOf(seedEvents))
		.mockReturnValueOnce(asyncIterableOf(generationEvents))
		.mockReturnValueOnce(asyncIterableOf(finalEvents));
}

beforeEach(() => {
	// Reset (not just clear): several tests use mockReturnValueOnce chains,
	// which mockClear alone would leak into the next test.
	vi.resetAllMocks();
	delete process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS;
});

describe('ClaudeManagedAgentPlugin — persistent control plane (default)', () => {
	it('creates + persists the control plane, runs the session with overrides, and preserves agent/environment', async () => {
		primeSingleSessionRun();
		const plugin = new ClaudeManagedAgentPlugin();
		const { context, updateSettings } = createContextStub({ apiKey: 'sk-test' });
		await plugin.onLoad(context);

		const result = await plugin.execute(WORK, { prompt: 'generate', config: {} } as never, EXISTING, execOptions());

		expect(result.success).toBe(true);
		expect(result.outputs.items).toHaveLength(1);
		expect(result.outputs.items[0].name).toBe('Alpha Tool');

		// Persistent agent + environment created once with stable names.
		expect(sdkMocks.agentsCreate).toHaveBeenCalledTimes(1);
		expect(sdkMocks.agentsCreate.mock.calls[0][0].name).toBe('Ever Works Managed Agent');
		expect(sdkMocks.environmentsCreate).toHaveBeenCalledTimes(1);
		expect(updateSettings).toHaveBeenCalledWith(
			'user',
			'user-1',
			expect.objectContaining({
				settings: expect.objectContaining({ managedAgentId: 'agent_1' })
			})
		);

		// Session pins the model via agent_with_overrides — no version churn.
		expect(sdkMocks.sessionsCreate.mock.calls[0][0].agent).toEqual({
			type: 'agent_with_overrides',
			id: 'agent_1',
			model: 'claude-sonnet-4-6'
		});

		// Cleanup: session archived, seed file removed, control plane kept.
		expect(sdkMocks.sessionsArchive).toHaveBeenCalledWith('session_1');
		expect(sdkMocks.sessionsDelete).not.toHaveBeenCalled();
		expect(sdkMocks.filesDelete).toHaveBeenCalled();
		expect(sdkMocks.environmentsDelete).not.toHaveBeenCalled();
		expect(sdkMocks.agentsArchive).not.toHaveBeenCalled();

		// Single-session usage reaches the platform seam too (list_cost "250" = $2.50).
		expect(extractUsageLikePlatform(result.metrics as ManagedAgentPipelineMetrics)).toEqual({
			total_tokens_used: 200,
			total_cost: 2.5
		});
	});

	it('passes the per-session budget cap on the single-session path', async () => {
		primeSingleSessionRun();
		const plugin = new ClaudeManagedAgentPlugin();
		const { context } = createContextStub({ apiKey: 'sk-test' });
		await plugin.onLoad(context);

		const result = await plugin.execute(
			WORK,
			{ prompt: 'generate', config: { per_session_budget_usd: 12 } } as never,
			EXISTING,
			execOptions()
		);

		expect(result.success).toBe(true);
		expect(sdkMocks.sessionsCreate.mock.calls[0][0].budget).toEqual({
			type: 'limit',
			max_list_cost: { amount: '1200', currency: 'USD' }
		});
	});

	// Regression: `cache_read_input_tokens` / `cache_creation_input_tokens` are
	// billed input tokens reported OUTSIDE `input_tokens`. Counting only
	// input+output made the single-session path under-report the rollup by
	// orders of magnitude (agent sessions re-read a big cached prefix per turn).
	it('counts cached input tokens in the usage that reaches the platform seam', async () => {
		primeSingleSessionRun();
		sdkMocks.sessionsRetrieve.mockResolvedValue({
			id: 'session_1',
			status: 'idle',
			usage: {
				input_tokens: 120,
				output_tokens: 80,
				cache_creation_input_tokens: 5000,
				cache_read_input_tokens: 300000,
				list_cost: { amount: '250', currency: 'USD' }
			}
		});

		const plugin = new ClaudeManagedAgentPlugin();
		const { context } = createContextStub({ apiKey: 'sk-test' });
		await plugin.onLoad(context);

		const result = await plugin.execute(WORK, { prompt: 'generate', config: {} } as never, EXISTING, execOptions());

		expect(result.success).toBe(true);
		expect(extractUsageLikePlatform(result.metrics as ManagedAgentPipelineMetrics)).toEqual({
			total_tokens_used: 305200,
			total_cost: 2.5
		});
	});

	it('registers the fan-out service as a custom capability on load', async () => {
		const plugin = new ClaudeManagedAgentPlugin();
		const { context, registerCustomCapability, registry } = createContextStub({ apiKey: 'sk-test' });

		await plugin.onLoad(context);

		expect(registerCustomCapability).toHaveBeenCalledTimes(1);
		expect(registerCustomCapability.mock.calls[0][0]).toEqual(
			expect.objectContaining({ name: CMA_FAN_OUT_CAPABILITY, methods: ['runSessions'] })
		);
		expect(typeof (registry.get(CMA_FAN_OUT_CAPABILITY) as { runSessions: unknown }).runSessions).toBe('function');
	});

	it('does not re-register (or throw) when the plugin is loaded twice', async () => {
		const plugin = new ClaudeManagedAgentPlugin();
		const { context, registerCustomCapability, logger } = createContextStub({ apiKey: 'sk-test' });

		await plugin.onLoad(context);
		await expect(plugin.onLoad(context)).resolves.toBeUndefined();

		expect(registerCustomCapability).toHaveBeenCalledTimes(1);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('splices memory recall into the session system override, not the persistent agent', async () => {
		primeSingleSessionRun();
		const plugin = new ClaudeManagedAgentPlugin();
		const { context } = createContextStub({ apiKey: 'sk-test' });
		await plugin.onLoad(context);

		const options = execOptions() as { execContext: Record<string, unknown> };
		options.execContext.memoryRecall = '<agent_memory>remember this</agent_memory>';

		const result = await plugin.execute(
			WORK,
			{ prompt: 'generate', config: {} } as never,
			EXISTING,
			options as never
		);

		expect(result.success).toBe(true);
		// The persistent agent keeps the base system prompt...
		expect(sdkMocks.agentsCreate.mock.calls[0][0].system).not.toContain('agent_memory');
		// ...while the session override carries the spliced recall block.
		const sessionAgent = sdkMocks.sessionsCreate.mock.calls[0][0].agent;
		expect(sessionAgent.type).toBe('agent_with_overrides');
		expect(sessionAgent.system).toContain('<agent_memory>remember this</agent_memory>');
	});
});

describe('ClaudeManagedAgentPlugin — ephemeral fallback (reuseControlPlane: false)', () => {
	it('creates work-scoped agent/environment and tears everything down after the run', async () => {
		primeSingleSessionRun();
		const plugin = new ClaudeManagedAgentPlugin();
		const { context, updateSettings } = createContextStub({ apiKey: 'sk-test', reuseControlPlane: false });
		await plugin.onLoad(context);

		const result = await plugin.execute(WORK, { prompt: 'generate', config: {} } as never, EXISTING, execOptions());

		expect(result.success).toBe(true);
		expect(sdkMocks.agentsCreate.mock.calls[0][0].name).toBe('Ever Works Agent: my-work');
		// Plain agent id — no overrides in the legacy path.
		expect(sdkMocks.sessionsCreate.mock.calls[0][0].agent).toBe('agent_1');
		// No control-plane state persisted in ephemeral mode.
		expect(updateSettings).not.toHaveBeenCalled();

		// Cleanup: full teardown (session deleted, environment deleted, agent archived).
		expect(sdkMocks.sessionsDelete).toHaveBeenCalledWith('session_1');
		expect(sdkMocks.environmentsDelete).toHaveBeenCalledWith('env_1');
		expect(sdkMocks.agentsArchive).toHaveBeenCalledWith('agent_1');
		expect(sdkMocks.filesDelete).toHaveBeenCalled();
	});

	// Regression: the ephemeral branch built its environment inline and never
	// consulted execContext.runtimeEnvironment, so an explicitly limited egress
	// policy was silently downgraded to the env-var default (unrestricted)
	// whenever "Reuse Control Plane" was off. Networking is a security control:
	// both modes must honor it.
	it('honors the runtime environment networking policy in ephemeral mode', async () => {
		primeSingleSessionRun();
		const plugin = new ClaudeManagedAgentPlugin();
		const { context } = createContextStub({ apiKey: 'sk-test', reuseControlPlane: false });
		await plugin.onLoad(context);

		const options = execOptions() as { execContext: Record<string, unknown> };
		// Flat `RuntimeEnvironmentData` — the shipped platform contract. (This
		// fixture used to build a nested `{ networking: { … } }` object, the
		// plugin's own pre-contract guess, which never matched real data.)
		options.execContext.runtimeEnvironment = {
			id: 'env-1',
			name: 'Limited Egress',
			slug: 'limited-egress',
			pipPackages: [],
			npmPackages: [],
			networkingMode: 'limited',
			allowedHosts: ['api.example.com'],
			allowPackageManagers: true
		};

		const result = await plugin.execute(
			WORK,
			{ prompt: 'generate', config: {} } as never,
			EXISTING,
			options as never
		);

		expect(result.success).toBe(true);
		expect(sdkMocks.environmentsCreate.mock.calls[0][0].config.networking).toEqual({
			type: 'limited',
			allowed_hosts: ['api.example.com'],
			allow_package_managers: true,
			allow_mcp_servers: false
		});
	});
});

describe('ClaudeManagedAgentPlugin — variant fan-out', () => {
	function primeVariantRun(failingSession?: string) {
		sdkMocks.filesUpload.mockResolvedValue({ id: 'file_1' });
		sdkMocks.filesDelete.mockResolvedValue({});
		sdkMocks.agentsCreate.mockResolvedValue({ id: 'agent_1' });
		sdkMocks.environmentsCreate.mockResolvedValue({ id: 'env_1' });
		sdkMocks.sessionsArchive.mockResolvedValue({});
		sdkMocks.eventsSend.mockResolvedValue({});

		let sessionCounter = 0;
		sdkMocks.sessionsCreate.mockImplementation(async () => {
			sessionCounter += 1;
			return { id: `session_${sessionCounter}`, status: 'running' };
		});
		sdkMocks.sessionsRetrieve.mockImplementation(async (sessionId: string) => ({
			id: sessionId,
			status: sessionId === failingSession ? 'terminated' : 'idle',
			usage: { input_tokens: 100, output_tokens: 40, list_cost: { amount: '150', currency: 'USD' } }
		}));
		sdkMocks.eventsList.mockImplementation((sessionId: string) =>
			asyncIterableOf([
				agentMessage(`${sessionId}_msg`, FINAL_JSON(`Item ${sessionId}`, `https://example.com/${sessionId}`)),
				idleEvent(`${sessionId}_idle`)
			])
		);
	}

	it('fans out N sessions, merges variant outputs, and archives each session', async () => {
		primeVariantRun();
		const plugin = new ClaudeManagedAgentPlugin();
		const { context } = createContextStub({ apiKey: 'sk-test' });
		await plugin.onLoad(context);

		const result = await plugin.execute(
			WORK,
			{ prompt: 'generate', config: { variant_sessions: 3, per_session_budget_usd: 5 } } as never,
			EXISTING,
			execOptions()
		);

		expect(result.success).toBe(true);
		// Three distinct items (one per variant session) merged into one output.
		expect(result.outputs.items).toHaveLength(3);
		expect(sdkMocks.sessionsCreate).toHaveBeenCalledTimes(3);

		// Per-session budget cap is passed as a create-only budget limit.
		for (const call of sdkMocks.sessionsCreate.mock.calls) {
			expect(call[0].budget).toEqual({
				type: 'limit',
				max_list_cost: { amount: '500', currency: 'USD' }
			});
			expect(call[0].initial_events).toHaveLength(1);
		}

		// Every fan-out session is archived.
		expect(sdkMocks.sessionsArchive).toHaveBeenCalledTimes(3);

		// Aggregated usage lands at the METRICS ROOT, where the platform's
		// extractPipelineUsageMetrics() reads it. Nesting it under `custom`
		// (as an earlier revision did) makes it invisible to every rollup.
		const metrics = result.metrics as ManagedAgentPipelineMetrics;
		expect(metrics.tokenUsage).toEqual({ total: { totalTokens: 3 * 140 } });
		expect(metrics.totalCost).toBeCloseTo(4.5);
		expect(metrics.custom?.sessions).toHaveLength(3);
		expect(extractUsageLikePlatform(metrics)).toEqual({
			total_tokens_used: 420,
			total_cost: 4.5
		});
	});

	it('keeps the run green when one variant fails and surfaces the failure as a warning', async () => {
		primeVariantRun('session_2');
		const plugin = new ClaudeManagedAgentPlugin();
		const { context } = createContextStub({ apiKey: 'sk-test' });
		await plugin.onLoad(context);

		const result = await plugin.execute(
			WORK,
			{ prompt: 'generate', config: { variant_sessions: 3 } } as never,
			EXISTING,
			execOptions()
		);

		expect(result.success).toBe(true);
		expect(result.outputs.items).toHaveLength(2);
		expect(result.warnings?.some((warning) => warning.includes('variant-2'))).toBe(true);
	});

	it('fails the run when every variant session fails', async () => {
		primeVariantRun();
		sdkMocks.sessionsRetrieve.mockImplementation(async (sessionId: string) => ({
			id: sessionId,
			status: 'terminated'
		}));
		const plugin = new ClaudeManagedAgentPlugin();
		const { context } = createContextStub({ apiKey: 'sk-test' });
		await plugin.onLoad(context);

		const result = await plugin.execute(
			WORK,
			{ prompt: 'generate', config: { variant_sessions: 2 } } as never,
			EXISTING,
			execOptions()
		);

		expect(result.success).toBe(false);
		expect(result.error?.message).toContain('variant sessions failed');
	});
});

describe('ClaudeManagedAgentPlugin — runSessions fan-out service', () => {
	it('reuses the persistent control plane and returns per-prompt results', async () => {
		sdkMocks.agentsCreate.mockResolvedValue({ id: 'agent_1' });
		sdkMocks.environmentsCreate.mockResolvedValue({ id: 'env_1' });
		sdkMocks.sessionsArchive.mockResolvedValue({});
		let sessionCounter = 0;
		sdkMocks.sessionsCreate.mockImplementation(async () => {
			sessionCounter += 1;
			return { id: `session_${sessionCounter}`, status: 'running' };
		});
		sdkMocks.sessionsRetrieve.mockImplementation(async (sessionId: string) => ({
			id: sessionId,
			status: 'idle',
			usage: { input_tokens: 10, output_tokens: 5, list_cost: { amount: '50', currency: 'USD' } }
		}));
		sdkMocks.eventsList.mockImplementation((sessionId: string) =>
			asyncIterableOf([agentMessage(`${sessionId}_msg`, `answer from ${sessionId}`)])
		);

		const plugin = new ClaudeManagedAgentPlugin();
		const { context } = createContextStub({ apiKey: 'sk-test' });
		await plugin.onLoad(context);

		const results = await plugin.runSessions({
			userId: 'user-1',
			prompts: [
				{ id: 'a', prompt: 'first prompt' },
				{ id: 'b', prompt: 'second prompt' }
			],
			perSessionBudgetUsd: 1
		});

		expect(results).toHaveLength(2);
		expect(results.map((r) => r.status)).toEqual(['completed', 'completed']);
		expect(results[0].output).toContain('answer from');
		expect(results[0].costUsd).toBe(0.5);
		// Control plane preserved — fan-out only archives its sessions.
		expect(sdkMocks.sessionsArchive).toHaveBeenCalledTimes(2);
		expect(sdkMocks.agentsArchive).not.toHaveBeenCalled();
		expect(sdkMocks.environmentsDelete).not.toHaveBeenCalled();
	});

	it('tears down the ephemeral control plane after the batch when reuse is disabled', async () => {
		sdkMocks.agentsCreate.mockResolvedValue({ id: 'agent_eph' });
		sdkMocks.agentsArchive.mockResolvedValue({});
		sdkMocks.environmentsCreate.mockResolvedValue({ id: 'env_eph' });
		sdkMocks.environmentsDelete.mockResolvedValue({});
		sdkMocks.sessionsArchive.mockResolvedValue({});
		sdkMocks.sessionsCreate.mockResolvedValue({ id: 'session_1', status: 'running' });
		sdkMocks.sessionsRetrieve.mockResolvedValue({ id: 'session_1', status: 'idle' });
		sdkMocks.eventsList.mockImplementation(() => asyncIterableOf([agentMessage('m1', 'done')]));

		const plugin = new ClaudeManagedAgentPlugin();
		const { context, updateSettings } = createContextStub({ apiKey: 'sk-test', reuseControlPlane: false });
		await plugin.onLoad(context);

		const results = await plugin.runSessions({
			userId: 'user-1',
			prompts: [{ id: 'a', prompt: 'only prompt' }]
		});

		expect(results[0].status).toBe('completed');
		expect(updateSettings).not.toHaveBeenCalled();
		expect(sdkMocks.environmentsDelete).toHaveBeenCalledWith('env_eph');
		expect(sdkMocks.agentsArchive).toHaveBeenCalledWith('agent_eph');
	});

	it('caps a caller-supplied per-session budget at the plugin ceiling', async () => {
		sdkMocks.agentsCreate.mockResolvedValue({ id: 'agent_1' });
		sdkMocks.environmentsCreate.mockResolvedValue({ id: 'env_1' });
		sdkMocks.sessionsArchive.mockResolvedValue({});
		sdkMocks.sessionsCreate.mockResolvedValue({ id: 'session_1', status: 'running' });
		sdkMocks.sessionsRetrieve.mockResolvedValue({ id: 'session_1', status: 'idle' });
		sdkMocks.eventsList.mockImplementation(() => asyncIterableOf([agentMessage('m1', 'done')]));

		const plugin = new ClaudeManagedAgentPlugin();
		const { context } = createContextStub({ apiKey: 'sk-test' });
		await plugin.onLoad(context);

		await plugin.runSessions({
			userId: 'user-1',
			prompts: [{ id: 'a', prompt: 'x' }],
			perSessionBudgetUsd: 100000
		});

		// MAX_PER_SESSION_BUDGET_USD (500) in integer minor units.
		expect(sdkMocks.sessionsCreate.mock.calls[0][0].budget).toEqual({
			type: 'limit',
			max_list_cost: { amount: '50000', currency: 'USD' }
		});
	});

	it('throws without a userId and returns [] for empty prompt lists', async () => {
		const plugin = new ClaudeManagedAgentPlugin();
		const { context } = createContextStub({ apiKey: 'sk-test' });
		await plugin.onLoad(context);

		await expect(plugin.runSessions({ userId: '', prompts: [{ id: 'a', prompt: 'x' }] })).rejects.toThrow('userId');
		expect(await plugin.runSessions({ userId: 'user-1', prompts: [] })).toEqual([]);
	});
});

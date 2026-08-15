import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	SETTING_MANAGED_AGENT_CONFIG_HASH,
	SETTING_MANAGED_AGENT_ID,
	SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH,
	SETTING_MANAGED_ENVIRONMENT_ID,
	type ManagedAgentDesiredConfig
} from '../types.js';
import {
	computeConfigHash,
	ensureControlPlane,
	ensureManagedAgent,
	ensureManagedEnvironment,
	resolveNetworking
} from './control-plane.js';
import type { AnthropicManagedAgentsClient } from './managed-agents-client.js';

const ORIGINAL_EGRESS_ENV = process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS;

const DESIRED: ManagedAgentDesiredConfig = {
	name: 'Ever Works Managed Agent',
	description: 'Persistent Ever Works managed generation agent',
	model: 'claude-sonnet-4-6',
	system: 'base system prompt'
};

const LOGGER = { log: vi.fn(), warn: vi.fn() };

function createClientStub() {
	return {
		createAgent: vi.fn().mockResolvedValue({ id: 'agent_new' }),
		updateAgent: vi.fn().mockResolvedValue({ id: 'agent_stored' }),
		getAgent: vi.fn().mockResolvedValue({ id: 'agent_stored', archivedAt: null }),
		createEnvironment: vi.fn().mockResolvedValue({ id: 'env_new' }),
		updateEnvironment: vi.fn().mockResolvedValue({ id: 'env_stored' }),
		getEnvironment: vi.fn().mockResolvedValue({ id: 'env_stored', archivedAt: null })
	};
}

type ClientStub = ReturnType<typeof createClientStub>;

function asClient(stub: ClientStub): AnthropicManagedAgentsClient {
	return stub as unknown as AnthropicManagedAgentsClient;
}

function createContextStub() {
	const updateSettings = vi.fn().mockResolvedValue(undefined);
	return {
		context: {
			updateSettings,
			logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
		} as never,
		updateSettings
	};
}

function desiredAgentHash(): string {
	return computeConfigHash({
		name: DESIRED.name,
		description: DESIRED.description ?? null,
		system: DESIRED.system
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	delete process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS;
});

afterEach(() => {
	if (ORIGINAL_EGRESS_ENV === undefined) {
		delete process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS;
	} else {
		process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS = ORIGINAL_EGRESS_ENV;
	}
});

describe('computeConfigHash', () => {
	it('is stable across key order', () => {
		expect(computeConfigHash({ a: 1, b: 'two' })).toBe(computeConfigHash({ b: 'two', a: 1 }));
	});

	it('changes when a value changes', () => {
		expect(computeConfigHash({ system: 'v1' })).not.toBe(computeConfigHash({ system: 'v2' }));
	});

	it('ignores undefined values', () => {
		expect(computeConfigHash({ a: 1, b: undefined })).toBe(computeConfigHash({ a: 1 }));
	});
});

describe('resolveNetworking', () => {
	it('maps a limited runtime environment to the limited networking policy', () => {
		expect(
			resolveNetworking({
				networking: {
					type: 'limited',
					allowedHosts: ['api.example.com', ' '],
					allowPackageManagers: true,
					allowMcpServers: false
				}
			})
		).toEqual({
			type: 'limited',
			allowed_hosts: ['api.example.com'],
			allow_package_managers: true,
			allow_mcp_servers: false
		});
	});

	it('maps an unrestricted runtime environment', () => {
		expect(resolveNetworking({ networking: { type: 'unrestricted' } })).toEqual({ type: 'unrestricted' });
	});

	it('falls back to the env-var policy when no runtime environment is present', () => {
		process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS = 'pinned.example';
		expect(resolveNetworking(null)).toEqual({
			type: 'limited',
			allowed_hosts: ['pinned.example'],
			allow_package_managers: false,
			allow_mcp_servers: false
		});
	});

	it('falls back to unrestricted for unknown networking types', () => {
		expect(resolveNetworking({ networking: { type: 'mystery' } })).toEqual({ type: 'unrestricted' });
	});
});

describe('ensureManagedAgent', () => {
	it('creates and persists the agent when no id is stored', async () => {
		const stub = createClientStub();
		const { context, updateSettings } = createContextStub();

		const result = await ensureManagedAgent(asClient(stub), context, 'user-1', {}, DESIRED, LOGGER);

		expect(result.agentId).toBe('agent_new');
		expect(stub.createAgent).toHaveBeenCalledWith({
			name: DESIRED.name,
			description: DESIRED.description,
			model: DESIRED.model,
			system: DESIRED.system
		});
		expect(updateSettings).toHaveBeenCalledWith('user', 'user-1', {
			settings: {
				[SETTING_MANAGED_AGENT_ID]: 'agent_new',
				[SETTING_MANAGED_AGENT_CONFIG_HASH]: desiredAgentHash()
			}
		});
	});

	it('reuses the stored agent when the config hash matches', async () => {
		const stub = createClientStub();
		const { context, updateSettings } = createContextStub();

		const result = await ensureManagedAgent(
			asClient(stub),
			context,
			'user-1',
			{
				[SETTING_MANAGED_AGENT_ID]: 'agent_stored',
				[SETTING_MANAGED_AGENT_CONFIG_HASH]: desiredAgentHash()
			},
			DESIRED,
			LOGGER
		);

		expect(result.agentId).toBe('agent_stored');
		expect(stub.getAgent).toHaveBeenCalledWith('agent_stored');
		expect(stub.createAgent).not.toHaveBeenCalled();
		expect(stub.updateAgent).not.toHaveBeenCalled();
		expect(updateSettings).not.toHaveBeenCalled();
	});

	it('version-bumps via update when the config hash drifts', async () => {
		const stub = createClientStub();
		const { context, updateSettings } = createContextStub();

		const result = await ensureManagedAgent(
			asClient(stub),
			context,
			'user-1',
			{
				[SETTING_MANAGED_AGENT_ID]: 'agent_stored',
				[SETTING_MANAGED_AGENT_CONFIG_HASH]: 'stale-hash'
			},
			DESIRED,
			LOGGER
		);

		expect(result.agentId).toBe('agent_stored');
		expect(stub.updateAgent).toHaveBeenCalledWith('agent_stored', {
			name: DESIRED.name,
			description: DESIRED.description,
			model: DESIRED.model,
			system: DESIRED.system
		});
		expect(stub.createAgent).not.toHaveBeenCalled();
		expect(updateSettings).toHaveBeenCalledWith('user', 'user-1', {
			settings: { [SETTING_MANAGED_AGENT_CONFIG_HASH]: desiredAgentHash() }
		});
	});

	it('recreates the agent when the stored one no longer exists', async () => {
		const stub = createClientStub();
		stub.getAgent.mockRejectedValue(new Error('404 not found'));
		const { context, updateSettings } = createContextStub();

		const result = await ensureManagedAgent(
			asClient(stub),
			context,
			'user-1',
			{
				[SETTING_MANAGED_AGENT_ID]: 'agent_gone',
				[SETTING_MANAGED_AGENT_CONFIG_HASH]: desiredAgentHash()
			},
			DESIRED,
			LOGGER
		);

		expect(result.agentId).toBe('agent_new');
		expect(stub.createAgent).toHaveBeenCalledTimes(1);
		expect(updateSettings).toHaveBeenCalledWith('user', 'user-1', {
			settings: {
				[SETTING_MANAGED_AGENT_ID]: 'agent_new',
				[SETTING_MANAGED_AGENT_CONFIG_HASH]: desiredAgentHash()
			}
		});
	});

	it('recreates the agent when the stored one is archived', async () => {
		const stub = createClientStub();
		stub.getAgent.mockResolvedValue({ id: 'agent_stored', archivedAt: '2026-08-01T00:00:00Z' });
		const { context } = createContextStub();

		const result = await ensureManagedAgent(
			asClient(stub),
			context,
			'user-1',
			{
				[SETTING_MANAGED_AGENT_ID]: 'agent_stored',
				[SETTING_MANAGED_AGENT_CONFIG_HASH]: desiredAgentHash()
			},
			DESIRED,
			LOGGER
		);

		expect(result.agentId).toBe('agent_new');
		expect(stub.createAgent).toHaveBeenCalledTimes(1);
	});

	it('still returns the agent id when persisting state fails', async () => {
		const stub = createClientStub();
		const { context, updateSettings } = createContextStub();
		updateSettings.mockRejectedValue(new Error('settings store down'));

		const result = await ensureManagedAgent(asClient(stub), context, 'user-1', {}, DESIRED, LOGGER);

		expect(result.agentId).toBe('agent_new');
		expect(LOGGER.warn).toHaveBeenCalled();
	});
});

describe('ensureManagedEnvironment', () => {
	it('creates and persists the environment with env-var fallback networking', async () => {
		const stub = createClientStub();
		const { context, updateSettings } = createContextStub();

		const result = await ensureManagedEnvironment(asClient(stub), context, 'user-1', {}, null, LOGGER);

		expect(result.environmentId).toBe('env_new');
		expect(stub.createEnvironment).toHaveBeenCalledWith({
			name: 'Ever Works Environment',
			networking: { type: 'unrestricted' }
		});
		expect(updateSettings).toHaveBeenCalledTimes(1);
		const persisted = updateSettings.mock.calls[0][2].settings;
		expect(persisted[SETTING_MANAGED_ENVIRONMENT_ID]).toBe('env_new');
		expect(typeof persisted[SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH]).toBe('string');
	});

	it('creates the environment from the runtime-environment context object', async () => {
		const stub = createClientStub();
		const { context } = createContextStub();

		await ensureManagedEnvironment(
			asClient(stub),
			context,
			'user-1',
			{},
			{
				name: 'Custom Env',
				networking: { type: 'limited', allowedHosts: ['api.example.com'] }
			},
			LOGGER
		);

		expect(stub.createEnvironment).toHaveBeenCalledWith({
			name: 'Custom Env',
			networking: {
				type: 'limited',
				allowed_hosts: ['api.example.com'],
				allow_package_managers: false,
				allow_mcp_servers: false
			}
		});
	});

	it('reuses the stored environment when the config hash matches', async () => {
		const stub = createClientStub();
		const { context, updateSettings } = createContextStub();

		const first = await ensureManagedEnvironment(asClient(stub), context, 'user-1', {}, null, LOGGER);
		const persistedHash = updateSettings.mock.calls[0][2].settings[SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH];
		updateSettings.mockClear();
		stub.createEnvironment.mockClear();
		stub.getEnvironment.mockResolvedValue({ id: first.environmentId, archivedAt: null });

		const second = await ensureManagedEnvironment(
			asClient(stub),
			context,
			'user-1',
			{
				[SETTING_MANAGED_ENVIRONMENT_ID]: first.environmentId,
				[SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH]: persistedHash
			},
			null,
			LOGGER
		);

		expect(second.environmentId).toBe(first.environmentId);
		expect(stub.createEnvironment).not.toHaveBeenCalled();
		expect(stub.updateEnvironment).not.toHaveBeenCalled();
		expect(updateSettings).not.toHaveBeenCalled();
	});

	it('updates the stored environment in place when the config drifts', async () => {
		const stub = createClientStub();
		const { context, updateSettings } = createContextStub();

		const result = await ensureManagedEnvironment(
			asClient(stub),
			context,
			'user-1',
			{
				[SETTING_MANAGED_ENVIRONMENT_ID]: 'env_stored',
				[SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH]: 'stale-hash'
			},
			{ networking: { type: 'limited', allowedHosts: ['api.example.com'] } },
			LOGGER
		);

		expect(result.environmentId).toBe('env_stored');
		expect(stub.updateEnvironment).toHaveBeenCalledWith('env_stored', {
			name: 'Ever Works Environment',
			networking: {
				type: 'limited',
				allowed_hosts: ['api.example.com'],
				allow_package_managers: false,
				allow_mcp_servers: false
			}
		});
		expect(stub.createEnvironment).not.toHaveBeenCalled();
		expect(updateSettings).toHaveBeenCalledWith('user', 'user-1', {
			settings: expect.objectContaining({
				[SETTING_MANAGED_ENVIRONMENT_CONFIG_HASH]: expect.any(String)
			})
		});
	});

	it('recreates the environment when the stored one no longer exists', async () => {
		const stub = createClientStub();
		stub.getEnvironment.mockRejectedValue(new Error('404 not found'));
		const { context } = createContextStub();

		const result = await ensureManagedEnvironment(
			asClient(stub),
			context,
			'user-1',
			{ [SETTING_MANAGED_ENVIRONMENT_ID]: 'env_gone' },
			null,
			LOGGER
		);

		expect(result.environmentId).toBe('env_new');
		expect(stub.createEnvironment).toHaveBeenCalledTimes(1);
	});
});

describe('ensureControlPlane', () => {
	it('reuses/persists agent + environment by default and reports ephemeral: false', async () => {
		const stub = createClientStub();
		const { context } = createContextStub();

		const result = await ensureControlPlane(asClient(stub), context, 'user-1', {}, DESIRED, null, LOGGER);

		expect(result).toEqual({ agentId: 'agent_new', environmentId: 'env_new', ephemeral: false });
	});

	it("falls back to today's ephemeral mode when reuseControlPlane is false", async () => {
		const stub = createClientStub();
		const { context, updateSettings } = createContextStub();

		const result = await ensureControlPlane(
			asClient(stub),
			context,
			'user-1',
			{
				reuseControlPlane: false,
				[SETTING_MANAGED_AGENT_ID]: 'agent_stored',
				[SETTING_MANAGED_AGENT_CONFIG_HASH]: desiredAgentHash()
			},
			DESIRED,
			null,
			LOGGER
		);

		expect(result.ephemeral).toBe(true);
		expect(result.agentId).toBe('agent_new');
		expect(result.environmentId).toBe('env_new');
		// Ephemeral mode never touches persisted control-plane state.
		expect(stub.getAgent).not.toHaveBeenCalled();
		expect(updateSettings).not.toHaveBeenCalled();
	});
});

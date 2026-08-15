import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `managed-agents-client.ts` constructs `new Anthropic(...)` and then
// calls `this.client.beta.environments.create(...)`. We mock the SDK
// so we can capture the `config.networking` payload that the
// AnthropicManagedAgentsClient.createEnvironment method sends.
const environmentsCreateMock = vi.fn().mockResolvedValue({ id: 'env_test' });

vi.mock('@anthropic-ai/sdk', () => {
	class AnthropicMock {
		beta = {
			agents: { list: vi.fn(), create: vi.fn(), archive: vi.fn() },
			environments: {
				create: environmentsCreateMock,
				delete: vi.fn()
			},
			sessions: {
				create: vi.fn(),
				delete: vi.fn(),
				archive: vi.fn(),
				retrieve: vi.fn(),
				events: { send: vi.fn(), list: vi.fn() }
			},
			files: { upload: vi.fn(), delete: vi.fn() }
		};
		constructor(_opts: unknown) {
			void _opts;
		}
	}

	return {
		default: AnthropicMock,
		toFile: vi.fn(async (buf: Buffer, name: string, opts?: unknown) => ({ buf, name, opts }))
	};
});

import { AnthropicManagedAgentsClient } from './managed-agents-client.js';

const ORIGINAL_ENV_VALUE = process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS;

describe('AnthropicManagedAgentsClient — egress allow-list (H-25)', () => {
	beforeEach(() => {
		environmentsCreateMock.mockClear();
		environmentsCreateMock.mockResolvedValue({ id: 'env_test' });
	});

	afterEach(() => {
		if (ORIGINAL_ENV_VALUE === undefined) {
			delete process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS;
		} else {
			process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS = ORIGINAL_ENV_VALUE;
		}
	});

	it('sends an allow-list when CLAUDE_MANAGED_AGENT_EGRESS_HOSTS is set', async () => {
		process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS = 'api.anthropic.com,foo.example';

		const client = new AnthropicManagedAgentsClient('test-key');
		await client.createEnvironment({ name: 'pinned-env' });

		expect(environmentsCreateMock).toHaveBeenCalledTimes(1);
		const callArgs = environmentsCreateMock.mock.calls[0][0];
		expect(callArgs.name).toBe('pinned-env');
		expect(callArgs.config.type).toBe('cloud');
		// SDK >= 0.117 typed networking policy: the former untyped
		// `{ type: 'allowlist', hosts }` payload became the documented
		// `limited` policy with explicit registry/MCP egress flags (off).
		expect(callArgs.config.networking).toEqual({
			type: 'limited',
			allowed_hosts: ['api.anthropic.com', 'foo.example'],
			allow_package_managers: false,
			allow_mcp_servers: false
		});
	});

	it('trims whitespace and drops empty entries from the host list', async () => {
		process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS = ' api.anthropic.com , , foo.example ,';

		const client = new AnthropicManagedAgentsClient('test-key');
		await client.createEnvironment({ name: 'pinned-env' });

		const callArgs = environmentsCreateMock.mock.calls[0][0];
		expect(callArgs.config.networking).toEqual({
			type: 'limited',
			allowed_hosts: ['api.anthropic.com', 'foo.example'],
			allow_package_managers: false,
			allow_mcp_servers: false
		});
	});

	it('defaults networking to `unrestricted` when env var is unset', async () => {
		delete process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS;

		const client = new AnthropicManagedAgentsClient('test-key');
		await client.createEnvironment({ name: 'default-env' });

		const callArgs = environmentsCreateMock.mock.calls[0][0];
		expect(callArgs.config.networking).toEqual({ type: 'unrestricted' });
	});

	it('defaults networking to `unrestricted` when env var is the empty string (defensive)', async () => {
		process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS = '';

		const client = new AnthropicManagedAgentsClient('test-key');
		await client.createEnvironment({ name: 'empty-env' });

		const callArgs = environmentsCreateMock.mock.calls[0][0];
		expect(callArgs.config.networking).toEqual({ type: 'unrestricted' });
	});

	it('defaults networking to `unrestricted` when env var is only whitespace (defensive)', async () => {
		process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS = '   ';

		const client = new AnthropicManagedAgentsClient('test-key');
		await client.createEnvironment({ name: 'whitespace-env' });

		const callArgs = environmentsCreateMock.mock.calls[0][0];
		expect(callArgs.config.networking).toEqual({ type: 'unrestricted' });
	});
});

describe('AnthropicManagedAgentsClient — Environments-driven networking', () => {
	beforeEach(() => {
		environmentsCreateMock.mockClear();
		environmentsCreateMock.mockResolvedValue({ id: 'env_test' });
	});

	afterEach(() => {
		if (ORIGINAL_ENV_VALUE === undefined) {
			delete process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS;
		} else {
			process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS = ORIGINAL_ENV_VALUE;
		}
	});

	it('an explicit `limited` networking config wins over the env-var fallback', async () => {
		process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS = 'should-not.be-used';

		const client = new AnthropicManagedAgentsClient('test-key');
		await client.createEnvironment({
			name: 'env-driven',
			networking: {
				type: 'limited',
				allowed_hosts: ['api.anthropic.com'],
				allow_package_managers: true,
				allow_mcp_servers: false
			}
		});

		const callArgs = environmentsCreateMock.mock.calls[0][0];
		expect(callArgs.config).toEqual({
			type: 'cloud',
			networking: {
				type: 'limited',
				allowed_hosts: ['api.anthropic.com'],
				allow_package_managers: true,
				allow_mcp_servers: false
			}
		});
	});

	it('an explicit `unrestricted` config also wins over the env-var fallback', async () => {
		process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS = 'pinned.example';

		const client = new AnthropicManagedAgentsClient('test-key');
		await client.createEnvironment({ name: 'env-open', networking: { type: 'unrestricted' } });

		const callArgs = environmentsCreateMock.mock.calls[0][0];
		expect(callArgs.config.networking).toEqual({ type: 'unrestricted' });
	});

	// The legacy `{ type: 'allowlist', hosts }` payload this assertion used to
	// pin was never verifiable against the pinned SDK's typed networking union;
	// `resolveEnvVarNetworking` emits `limited`. Re-pointed, not dropped: the
	// property under test is still "an undefined input defers to the env var".
	it('an undefined networking input falls back to the env-var policy', async () => {
		process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS = 'api.anthropic.com,foo.example';

		const client = new AnthropicManagedAgentsClient('test-key');
		await client.createEnvironment({ name: 'fallback-env', networking: undefined });

		const callArgs = environmentsCreateMock.mock.calls[0][0];
		expect(callArgs.config.networking).toEqual({
			type: 'limited',
			allowed_hosts: ['api.anthropic.com', 'foo.example'],
			allow_package_managers: false,
			allow_mcp_servers: false
		});
	});
});

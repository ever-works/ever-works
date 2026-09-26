import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEnvironmentData, StepExecutionContext } from '@ever-works/plugin';
// App Provisioner (APW-04 T1) — the pure resolver behind the enforced
// `limited` policy asserted through the sandbox path at the end of this file.
import { resolveEnvironmentNetworking } from './utils/runtime-environment.js';

/**
 * Environments — end-to-end plugin spec: an execContext WITH
 * `runtimeEnvironment` produces the CMA environment payload derived from
 * it plus an initial bootstrap install step, and an execContext WITHOUT
 * one produces no bootstrap message and the env-var networking policy.
 *
 * Integration note: this spec was authored on the Environments branch, when
 * every run created an EPHEMERAL agent + environment named after the Work
 * (`Ever Works Environment: <slug>`). `feat-cma-scale` then made the reusable
 * persistent control plane the DEFAULT (`reuseControlPlane !== false`), which
 * names the environment after the resolved Environment (falling back to
 * `PERSISTENT_ENVIRONMENT_NAME`) and resolves the networking policy eagerly so
 * it can be hashed for drift detection. The assertions below are re-pointed to
 * that default path — the property under test (the Environment drives
 * networking + the package bootstrap) is unchanged.
 */

const createEnvironmentMock = vi.fn().mockResolvedValue({ id: 'cma-env-1' });
const sendUserMessageMock = vi.fn().mockResolvedValue(undefined);
const listAllEventsMock = vi.fn();

// Spread the real module: `control-plane.ts` also imports
// `resolveEnvVarNetworking` from here, and a factory that returns only the
// client class leaves that export undefined — which surfaces as a bogus
// "configure-managed-agent step failed" on the no-Environment path (the only
// path that calls it) rather than as a mocking error.
vi.mock('./utils/managed-agents-client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./utils/managed-agents-client.js')>();

	class AnthropicManagedAgentsClientMock {
		validateAccess = vi.fn();
		createAgent = vi.fn().mockResolvedValue({ id: 'cma-agent-1' });
		archiveAgent = vi.fn();
		createEnvironment = createEnvironmentMock;
		deleteEnvironment = vi.fn();
		createSession = vi.fn().mockResolvedValue({ id: 'sess-1', status: 'running' });
		deleteSession = vi.fn();
		archiveSession = vi.fn();
		uploadTextFile = vi.fn().mockResolvedValue({ id: 'file-1' });
		deleteFile = vi.fn();
		getSession = vi.fn().mockResolvedValue({ id: 'sess-1', status: 'idle' });
		sendUserMessage = sendUserMessageMock;
		interruptSession = vi.fn();
		listAllEvents = listAllEventsMock;
		waitForSessionIdle = vi.fn().mockResolvedValue({ id: 'sess-1', status: 'idle' });
	}
	return { ...actual, AnthropicManagedAgentsClient: AnthropicManagedAgentsClientMock };
});

vi.mock('./utils/managed-agents-cleanup.js', () => ({
	cleanupManagedAgentRun: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('./utils/pipeline-helpers.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./utils/pipeline-helpers.js')>();
	return {
		...actual,
		resolveManagedAgentSettings: vi.fn().mockResolvedValue({ apiKey: 'test-api-key' })
	};
});

import { ClaudeManagedAgentPlugin } from './claude-managed-agent.plugin.js';

const WORK = { id: 'work-1', name: 'Test Work', slug: 'test-work', user: { id: 'user-1' } };

const STRUCTURED_OUTPUT = JSON.stringify({
	items: [{ name: 'Item One', description: 'Desc', source_url: 'https://example.com' }]
});

function primeEventLog(): void {
	// Sequence of `listAllEvents` snapshots the plugin takes:
	//   1. after the seed (and optional bootstrap) turns went idle,
	//   2. after the generation turn went idle,
	//   3. after the result-collection turn went idle.
	const seedEvents = [{ id: 'seed-1', type: 'user.message' }];
	const generationEvents = [
		...seedEvents,
		{ id: 'gen-idle', type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
	];
	const resultEvents = [
		...generationEvents,
		{
			id: 'result-msg',
			type: 'agent.message',
			content: [{ type: 'text', text: STRUCTURED_OUTPUT }]
		},
		{ id: 'result-idle', type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
	];
	listAllEventsMock
		.mockResolvedValueOnce(seedEvents)
		.mockResolvedValueOnce(generationEvents)
		.mockResolvedValueOnce(resultEvents);
}

function makeExecContext(runtimeEnvironment?: RuntimeEnvironmentData): StepExecutionContext {
	return {
		user: { id: 'user-1' },
		runtimeEnvironment
	} as unknown as StepExecutionContext;
}

const RUNTIME_ENVIRONMENT: RuntimeEnvironmentData = {
	id: 'env-1',
	name: 'Python Data',
	slug: 'python-data',
	pipPackages: ['pandas==2.2.0', 'requests'],
	npmPackages: ['typescript'],
	networkingMode: 'limited',
	allowedHosts: ['api.anthropic.com', 'pypi.org'],
	allowPackageManagers: true
};

async function runPlugin(runtimeEnvironment?: RuntimeEnvironmentData) {
	const plugin = new ClaudeManagedAgentPlugin();
	return plugin.execute(
		WORK,
		{ prompt: 'make items', config: { capture_screenshots: false } },
		{ items: [], categories: [], tags: [] },
		{ execContext: makeExecContext(runtimeEnvironment) }
	);
}

beforeEach(() => {
	// The env-var fallback is the no-Environment baseline asserted below, so
	// pin it unset rather than inherit whatever the ambient process carries.
	delete process.env.CLAUDE_MANAGED_AGENT_EGRESS_HOSTS;
	createEnvironmentMock.mockClear();
	sendUserMessageMock.mockClear();
	listAllEventsMock.mockReset();
	primeEventLog();
});

describe('ClaudeManagedAgentPlugin — runtimeEnvironment consumption', () => {
	it('builds the CMA environment from the resolved Environment and bootstraps its packages first', async () => {
		const result = await runPlugin(RUNTIME_ENVIRONMENT);
		expect(result.success).toBe(true);

		expect(createEnvironmentMock).toHaveBeenCalledTimes(1);
		expect(createEnvironmentMock).toHaveBeenCalledWith({
			name: 'Python Data',
			networking: {
				type: 'limited',
				allowed_hosts: ['api.anthropic.com', 'pypi.org'],
				allow_package_managers: true,
				allow_mcp_servers: false
			}
		});

		// Bootstrap install message is the FIRST session message, before
		// the workspace seed and the main prompt (4 messages total).
		expect(sendUserMessageMock).toHaveBeenCalledTimes(4);
		const firstMessage = sendUserMessageMock.mock.calls[0][1] as string;
		expect(firstMessage).toContain("pip install 'pandas==2.2.0' 'requests'");
		expect(firstMessage).toContain("npm install -g 'typescript'");
		const secondMessage = sendUserMessageMock.mock.calls[1][1] as string;
		expect(secondMessage).not.toContain('pip install');
	});

	it('without a runtimeEnvironment, falls back to the env-var networking policy and skips the bootstrap', async () => {
		const result = await runPlugin(undefined);
		expect(result.success).toBe(true);

		// No Environment → the env-var policy decides. The control plane
		// resolves it eagerly (it has to hash the config for drift detection)
		// rather than leaving `networking` undefined for the client to fill in;
		// with CLAUDE_MANAGED_AGENT_EGRESS_HOSTS unset both paths yield the
		// same `unrestricted` policy.
		expect(createEnvironmentMock).toHaveBeenCalledTimes(1);
		expect(createEnvironmentMock).toHaveBeenCalledWith({
			name: 'Ever Works Environment',
			networking: { type: 'unrestricted' }
		});

		// No bootstrap round-trip: seed, generation, result collection only.
		expect(sendUserMessageMock).toHaveBeenCalledTimes(3);
		for (const call of sendUserMessageMock.mock.calls) {
			expect(call[1] as string).not.toContain('pip install');
			expect(call[1] as string).not.toContain('npm install');
		}
	});

	it('an Environment with empty package lists skips the bootstrap step but keeps its networking', async () => {
		const result = await runPlugin({
			...RUNTIME_ENVIRONMENT,
			pipPackages: [],
			npmPackages: [],
			networkingMode: 'unrestricted',
			allowedHosts: null
		});
		expect(result.success).toBe(true);

		expect(createEnvironmentMock).toHaveBeenCalledWith({
			name: 'Python Data',
			networking: { type: 'unrestricted' }
		});
		expect(sendUserMessageMock).toHaveBeenCalledTimes(3);
	});
});

/**
 * APW-04 T1 — the provisioning half of the same property (ACC-04-05, unit
 * half; plan §7.3).
 *
 * `limited` networking is a SECURITY control on this path: the App
 * Provisioner runs over code the platform did not write, so the assertions
 * below are about what the sandbox CANNOT reach as much as what it can. The
 * host list below is the plan's §7.3 posture plus three entries that must
 * never survive into the policy: a cloud metadata address, `localhost`, and
 * an `.internal` suffix.
 */
const SANDBOX_RUNTIME_ENVIRONMENT: RuntimeEnvironmentData = {
	id: 'env-sandbox',
	name: 'Provisioning sandbox',
	slug: 'provisioning-sandbox',
	pipPackages: [],
	npmPackages: [],
	networkingMode: 'limited',
	allowedHosts: [
		'github.com',
		'codeload.github.com',
		'registry.npmjs.org',
		'169.254.169.254',
		'localhost',
		'metadata.internal'
	],
	allowPackageManagers: true
};

const SANDBOX_INPUT = {
	userId: 'user-1',
	workId: 'work-1',
	system: 'PROVISION-APP SKILL BODY',
	prompt: 'brief (already fenced)',
	runtimeEnvironment: SANDBOX_RUNTIME_ENVIRONMENT,
	attachedRepos: [
		{
			url: 'https://github.com/ever-works/fixture-app.git',
			branch: 'task/provision',
			mountDir: 'repo'
		}
	]
};

describe('ClaudeManagedAgentPlugin — restricted-network sandbox runtime (APW-04 T1)', () => {
	it('declares the enforcement flag AND the runner the provisioning path needs', () => {
		const plugin = new ClaudeManagedAgentPlugin();

		// Both halves are required: plan §7.3 — "a pipeline with the flag but
		// no runner is not a provisioning runtime".
		expect(plugin.enforcesRuntimeNetworking).toBe(true);
		expect(typeof plugin.runSandboxSession).toBe('function');
	});

	it('turns the §7.3 provisioning Environment into an enforced limited policy with MCP servers off', async () => {
		const plugin = new ClaudeManagedAgentPlugin();
		listAllEventsMock.mockReset().mockResolvedValue([
			{ id: 'agent-msg', type: 'agent.message', content: [{ type: 'text', text: 'provisioned' }] },
			{ id: 'idle-1', type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
		]);

		const result = await plugin.runSandboxSession(SANDBOX_INPUT);

		expect(result.status).toBe('completed');
		expect(createEnvironmentMock).toHaveBeenCalledWith({
			name: 'Ever Works Environment',
			networking: {
				type: 'limited',
				// The three valid hosts survive; the metadata address, the
				// loopback name and the internal suffix are dropped by the
				// shared allow-list validator before the policy is built.
				allowed_hosts: ['github.com', 'codeload.github.com', 'registry.npmjs.org'],
				allow_package_managers: true,
				allow_mcp_servers: false
			}
		});
	});

	it('control: an unrestricted Environment is NOT mapped to a limited policy', () => {
		// Known-good control for the assertion above — without it, a resolver
		// that returned `limited` for everything would pass this file.
		expect(
			resolveEnvironmentNetworking({
				...SANDBOX_RUNTIME_ENVIRONMENT,
				networkingMode: 'unrestricted',
				allowedHosts: null
			})
		).toEqual({ type: 'unrestricted' });
	});
});

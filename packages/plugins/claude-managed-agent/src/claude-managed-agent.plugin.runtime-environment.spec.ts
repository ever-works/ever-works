import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEnvironmentData, StepExecutionContext } from '@ever-works/plugin';

/**
 * Environments — end-to-end plugin spec: an execContext WITH
 * `runtimeEnvironment` produces the CMA environment payload derived from
 * it plus an initial bootstrap install step, and an execContext WITHOUT
 * one preserves today's payloads exactly (no bootstrap message, client
 * env-var fallback in charge of networking).
 */

const createEnvironmentMock = vi.fn().mockResolvedValue({ id: 'cma-env-1' });
const sendUserMessageMock = vi.fn().mockResolvedValue(undefined);
const listAllEventsMock = vi.fn();

vi.mock('./utils/managed-agents-client.js', () => {
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
	return { AnthropicManagedAgentsClient: AnthropicManagedAgentsClientMock };
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
			name: 'Ever Works Environment: test-work',
			networking: {
				type: 'limited',
				allowed_hosts: ['api.anthropic.com', 'pypi.org'],
				allow_package_managers: true
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

	it('without a runtimeEnvironment, payloads match the pre-Environments behavior exactly', async () => {
		const result = await runPlugin(undefined);
		expect(result.success).toBe(true);

		// networking stays undefined → the client's env-var fallback path
		// decides (covered byte-for-byte in managed-agents-client.spec.ts).
		expect(createEnvironmentMock).toHaveBeenCalledTimes(1);
		expect(createEnvironmentMock).toHaveBeenCalledWith({
			name: 'Ever Works Environment: test-work',
			networking: undefined
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
			name: 'Ever Works Environment: test-work',
			networking: { type: 'unrestricted' }
		});
		expect(sendUserMessageMock).toHaveBeenCalledTimes(3);
	});
});

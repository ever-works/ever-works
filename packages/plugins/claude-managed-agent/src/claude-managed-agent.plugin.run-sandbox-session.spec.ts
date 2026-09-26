import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEnvironmentData } from '@ever-works/plugin';

import { DEFAULT_MODEL, DEFAULT_WORKSPACE_PATH } from './types.js';

/**
 * APW-04 T1 — `ClaudeManagedAgentPlugin.runSandboxSession` (plan §2.6).
 *
 * This is the ONE entry point the App Provisioner executes a provisioning
 * run through, so the spec pins the four things the plan makes load-bearing:
 *
 *  1. the session's system prompt IS the caller's Skill body, and the brief
 *     is sent as its only message (the §7.3 environment declares no packages,
 *     so there is no bootstrap turn here);
 *  2. exactly ONE `github_repository` resource is mounted — tokenless, under
 *     `mountDir` — and NO file resource at all: no env file, no seed manifest,
 *     nothing that could carry a credential into the sandbox (FR-13);
 *  3. the agent + environment are ALWAYS ephemeral, even when the user's
 *     plugin setting asks for the reusable control plane, so a per-run
 *     restricted policy is never written onto a persistent environment, and
 *     the ephemeral pair is torn down afterwards;
 *  4. the terminal state maps onto `SandboxSessionResult` — including
 *     `requires_action` → `failed`/`requiresAction` (a sandbox session never
 *     pauses for a custom tool) and `usage` from the shared token seam.
 *
 * The client double covers exactly the methods `runSandboxSession` may reach;
 * a method it reaches that the double does not define surfaces as a failed
 * assertion rather than a silent pass.
 */

const mocks = vi.hoisted(() => ({
	createAgent: vi.fn(),
	archiveAgent: vi.fn(),
	createEnvironment: vi.fn(),
	deleteEnvironment: vi.fn(),
	createSession: vi.fn(),
	deleteSession: vi.fn(),
	archiveSession: vi.fn(),
	uploadTextFile: vi.fn(),
	deleteFile: vi.fn(),
	getAgent: vi.fn(),
	getEnvironment: vi.fn(),
	sendUserMessage: vi.fn(),
	interruptSession: vi.fn(),
	listAllEvents: vi.fn(),
	waitForSessionIdle: vi.fn(),
	cleanupManagedAgentRun: vi.fn(),
	resolveManagedAgentSettings: vi.fn()
}));

// Spread the real modules: `control-plane.ts` also imports
// `resolveEnvVarNetworking` from the client module and the runtime helpers from
// `pipeline-helpers.ts`, so a factory returning only the doubled members would
// leave those exports undefined — surfacing as a bogus step failure rather
// than as a mocking error.
vi.mock('./utils/managed-agents-client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./utils/managed-agents-client.js')>();

	class AnthropicManagedAgentsClientDouble {
		validateAccess = vi.fn();
		createAgent = mocks.createAgent;
		archiveAgent = mocks.archiveAgent;
		createEnvironment = mocks.createEnvironment;
		deleteEnvironment = mocks.deleteEnvironment;
		createSession = mocks.createSession;
		deleteSession = mocks.deleteSession;
		archiveSession = mocks.archiveSession;
		uploadTextFile = mocks.uploadTextFile;
		deleteFile = mocks.deleteFile;
		getAgent = mocks.getAgent;
		getEnvironment = mocks.getEnvironment;
		sendUserMessage = mocks.sendUserMessage;
		interruptSession = mocks.interruptSession;
		listAllEvents = mocks.listAllEvents;
		waitForSessionIdle = mocks.waitForSessionIdle;
	}

	return { ...actual, AnthropicManagedAgentsClient: AnthropicManagedAgentsClientDouble };
});

vi.mock('./utils/managed-agents-cleanup.js', () => ({
	cleanupManagedAgentRun: mocks.cleanupManagedAgentRun
}));

vi.mock('./utils/pipeline-helpers.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./utils/pipeline-helpers.js')>();
	return { ...actual, resolveManagedAgentSettings: mocks.resolveManagedAgentSettings };
});

import { ClaudeManagedAgentPlugin } from './claude-managed-agent.plugin.js';

const SKILL_BODY = 'PROVISION-APP SKILL BODY — read the repository, propose the App spec.';
const BRIEF = '<untrusted>the already-fenced brief</untrusted>';
const SESSION_ID = 'sess-sandbox';
const AGENT_ID = 'cma-agent-sandbox';
const ENVIRONMENT_ID = 'cma-env-sandbox';
const REPO_URL = 'https://github.com/ever-works/fixture-app.git';
const REPO_BRANCH = 'task/provision-fixture-app';

const SANDBOX_ENVIRONMENT: RuntimeEnvironmentData = {
	id: 'env-sandbox',
	name: 'Provisioning sandbox',
	slug: 'provisioning-sandbox',
	// §7.3: the provisioning Environment declares no packages (its allowed
	// registries are what the session installs from, if it needs to).
	pipPackages: [],
	npmPackages: [],
	networkingMode: 'limited',
	allowedHosts: ['github.com', 'codeload.github.com', 'registry.npmjs.org'],
	allowPackageManagers: true
};

function sandboxInput(overrides: Record<string, unknown> = {}) {
	return {
		userId: 'user-1',
		workId: 'work-1',
		system: SKILL_BODY,
		prompt: BRIEF,
		runtimeEnvironment: SANDBOX_ENVIRONMENT,
		attachedRepos: [{ url: REPO_URL, branch: REPO_BRANCH, mountDir: 'repo' }],
		budgetUsd: 2.5,
		timeoutMs: 45 * 60 * 1000,
		label: 'Provision ever-works/fixture-app',
		...overrides
	};
}

/** Two assistant messages so "the LAST one" is a real assertion. */
function completedEvents() {
	return [
		{ id: 'agent-msg-1', type: 'agent.message', content: [{ type: 'text', text: 'reading repository' }] },
		{ id: 'agent-msg-2', type: 'agent.message', content: [{ type: 'text', text: 'provision-output block' }] },
		{ id: 'idle-1', type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
	];
}

const FINAL_SESSION = {
	id: SESSION_ID,
	status: 'idle',
	usage: {
		input_tokens: 100,
		output_tokens: 40,
		cache_creation_input_tokens: 10,
		cache_read_input_tokens: 5,
		list_cost_usd: 2.5
	}
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createAgent.mockResolvedValue({ id: AGENT_ID });
	mocks.createEnvironment.mockResolvedValue({ id: ENVIRONMENT_ID });
	mocks.createSession.mockResolvedValue({ id: SESSION_ID, status: 'running' });
	mocks.deleteSession.mockResolvedValue(undefined);
	mocks.deleteEnvironment.mockResolvedValue(undefined);
	mocks.archiveAgent.mockResolvedValue(undefined);
	mocks.archiveSession.mockResolvedValue(undefined);
	mocks.deleteFile.mockResolvedValue(undefined);
	mocks.uploadTextFile.mockResolvedValue({ id: 'file-1' });
	mocks.getAgent.mockResolvedValue({ id: AGENT_ID, archivedAt: null });
	mocks.getEnvironment.mockResolvedValue({ id: ENVIRONMENT_ID, archivedAt: null });
	mocks.sendUserMessage.mockResolvedValue(undefined);
	mocks.interruptSession.mockResolvedValue(undefined);
	mocks.waitForSessionIdle.mockResolvedValue(FINAL_SESSION);
	mocks.listAllEvents.mockResolvedValue(completedEvents());
	mocks.cleanupManagedAgentRun.mockResolvedValue(undefined);
	// `reuseControlPlane: true` is the interesting setting: a sandbox session
	// must ignore it (asserted below).
	mocks.resolveManagedAgentSettings.mockResolvedValue({
		apiKey: 'test-api-key',
		model: DEFAULT_MODEL,
		pollIntervalMs: 500,
		reuseControlPlane: true
	});
});

function run(input = sandboxInput(), signal?: AbortSignal) {
	return new ClaudeManagedAgentPlugin().runSandboxSession(
		input as Parameters<ClaudeManagedAgentPlugin['runSandboxSession']>[0],
		signal
	);
}

describe('ClaudeManagedAgentPlugin.runSandboxSession — session shape', () => {
	it('sends the Skill body as the system prompt, one tokenless repository mount and the budget', async () => {
		const result = await run();

		// 1 — the Skill body is the session's system prompt (§2.6), and the
		// agent is created for this session only.
		expect(mocks.createAgent).toHaveBeenCalledTimes(1);
		expect(mocks.createAgent).toHaveBeenCalledWith(
			expect.objectContaining({ system: SKILL_BODY, model: DEFAULT_MODEL })
		);

		// 2 — exactly ONE resource, and it is the repository: tokenless URL,
		// mounted at `<workspace>/repo`, on the Task branch.
		expect(mocks.createSession).toHaveBeenCalledTimes(1);
		const sessionInput = mocks.createSession.mock.calls[0][0] as {
			agentId: string;
			environmentId: string;
			title: string;
			resources: unknown[];
			budgetUsd: number;
		};
		expect(sessionInput.agentId).toBe(AGENT_ID);
		expect(sessionInput.environmentId).toBe(ENVIRONMENT_ID);
		expect(sessionInput.title).toBe('Provision ever-works/fixture-app');
		expect(sessionInput.budgetUsd).toBe(2.5);
		expect(sessionInput.resources).toEqual([
			{
				type: 'github_repository',
				url: REPO_URL,
				branch: REPO_BRANCH,
				mount_path: `${DEFAULT_WORKSPACE_PATH}/repo`
			}
		]);

		// Nothing is uploaded into the sandbox: no env file, no seed manifest,
		// no credential (FR-13). A `file` resource would be the carrier.
		expect(mocks.uploadTextFile).not.toHaveBeenCalled();
		expect(sessionInput.resources.some((resource) => (resource as { type: string }).type === 'file')).toBe(false);

		// 3 — the brief is the only message (no package bootstrap: this
		// Environment declares no packages).
		expect(mocks.sendUserMessage).toHaveBeenCalledTimes(1);
		expect(mocks.sendUserMessage).toHaveBeenCalledWith(SESSION_ID, BRIEF);

		// 4 — terminal state: the LAST assistant message, and usage from the
		// shared token seam. `inputTokens` counts the cache counters too, so
		// inputTokens + outputTokens === toManagedSessionTokenUsage().totalTokens.
		expect(result).toEqual({
			status: 'completed',
			finalText: 'provision-output block',
			sessionId: SESSION_ID,
			usage: { inputTokens: 115, outputTokens: 40, costUsd: 2.5 }
		});
	});

	it('opens an EPHEMERAL agent + environment even when the setting asks for the persistent control plane', async () => {
		await run();

		// The reusable control plane would name the environment after the
		// resolved Environment; the ephemeral branch names it after the
		// constant. This is what proves the restricted policy cannot drift
		// onto a stored environment.
		expect(mocks.createEnvironment).toHaveBeenCalledWith({
			name: 'Ever Works Environment',
			networking: {
				type: 'limited',
				allowed_hosts: ['github.com', 'codeload.github.com', 'registry.npmjs.org'],
				allow_package_managers: true,
				allow_mcp_servers: false
			}
		});
		// Nothing was READ from a stored control plane, so nothing could be
		// updated on one either.
		expect(mocks.getAgent).not.toHaveBeenCalled();
		expect(mocks.getEnvironment).not.toHaveBeenCalled();

		// The ephemeral pair is torn down with the session: both ids are only
		// ever set on the ephemeral branch, so their presence here is the
		// teardown proof.
		expect(mocks.cleanupManagedAgentRun).toHaveBeenCalledTimes(1);
		expect(mocks.cleanupManagedAgentRun.mock.calls[0][1]).toEqual({
			createdAgentId: AGENT_ID,
			createdEnvironmentId: ENVIRONMENT_ID,
			sessionId: SESSION_ID
		});
	});
});

describe('ClaudeManagedAgentPlugin.runSandboxSession — terminal states', () => {
	it('reports requires_action as failed/requiresAction instead of throwing or waiting', async () => {
		mocks.listAllEvents.mockResolvedValue([
			{ id: 'agent-msg-1', type: 'agent.message', content: [{ type: 'text', text: 'open_pr failed' }] },
			{ id: 'idle-1', type: 'session.status_idle', stop_reason: { type: 'requires_action' } }
		]);

		const result = await run();

		expect(result.status).toBe('failed');
		expect(result.failureCode).toBe('requiresAction');
		expect(result.finalText).toBeNull();
		expect(result.sessionId).toBe(SESSION_ID);
	});

	it('reports a session with no assistant message as failed/noAgentMessage', async () => {
		mocks.listAllEvents.mockResolvedValue([
			{ id: 'idle-1', type: 'session.status_idle', stop_reason: { type: 'end_turn' } }
		]);

		const result = await run();

		expect(result.status).toBe('failed');
		expect(result.failureCode).toBe('noAgentMessage');
		expect(result.finalText).toBeNull();
	});

	it('maps a provider failure to failed/provider and still tears the session down', async () => {
		mocks.createSession.mockRejectedValue(new Error('sessions are unavailable'));

		const result = await run();

		expect(result).toEqual({
			status: 'failed',
			failureCode: 'provider',
			finalText: null,
			sessionId: undefined
		});
		expect(mocks.cleanupManagedAgentRun).toHaveBeenCalledTimes(1);
	});

	it('classifies the caller wall clock: bounded poll attempts, and a wait past it is a timeout', async () => {
		// `timeoutMs` drives BOTH the attempt bound handed to the client's poll
		// loop and the deadline the wait failure is measured against.
		mocks.waitForSessionIdle.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			throw new Error('Timed out waiting for Claude Managed Agents session to become idle.');
		});

		const result = await run(sandboxInput({ timeoutMs: 1 }));

		expect(mocks.waitForSessionIdle).toHaveBeenCalledWith(
			SESSION_ID,
			expect.objectContaining({ maxPollAttempts: 1, pollIntervalMs: 500 })
		);
		expect(result.status).toBe('timeout');
		expect(result.failureCode).toBeUndefined();
		expect(result.finalText).toBeNull();
	});

	it('reports no session at all when the caller has already cancelled', async () => {
		const controller = new AbortController();
		controller.abort();

		const result = await run(sandboxInput(), controller.signal);

		expect(result).toEqual({ status: 'cancelled', finalText: null });
		expect(mocks.createSession).not.toHaveBeenCalled();
		expect(mocks.cleanupManagedAgentRun).not.toHaveBeenCalled();
	});

	it('honours a provider stop reason that names budget exhaustion (provisional mapping)', async () => {
		mocks.listAllEvents.mockResolvedValue([
			{ id: 'agent-msg-1', type: 'agent.message', content: [{ type: 'text', text: 'partial' }] },
			{ id: 'idle-1', type: 'session.status_idle', stop_reason: { type: 'budget_exhausted' } }
		]);

		const result = await run();

		expect(result.status).toBe('budget-exhausted');
		expect(result.finalText).toBe('partial');
		expect(result.failureCode).toBeUndefined();
	});
});

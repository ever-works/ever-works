import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockVerifyDeviceAuthConnection } = vi.hoisted(() => ({
	mockVerifyDeviceAuthConnection: vi.fn()
}));

vi.mock('../device-auth.js', () => ({
	verifyDeviceAuthConnection: mockVerifyDeviceAuthConnection
}));

import {
	getManagedCodexHome,
	hasDeviceCodexAuth,
	resolveCodexHome,
	resolveExecutionAuth,
	updateStepState,
	initializeState
} from '../utils/pipeline-helpers.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-plugin-test-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
	mockVerifyDeviceAuthConnection.mockReset();
	mockVerifyDeviceAuthConnection.mockResolvedValue(false);
});

describe('pipeline-helpers', () => {
	it('prefers api key auth when provided', async () => {
		const auth = await resolveExecutionAuth({ apiKey: 'sk-test' });

		expect(auth).toEqual({
			mode: 'api-key',
			env: { OPENAI_API_KEY: 'sk-test' }
		});
	});

	it('honors explicit device-auth mode even when an api key exists', async () => {
		const codexHome = await makeTempDir();
		mockVerifyDeviceAuthConnection.mockResolvedValue(true);

		const auth = await resolveExecutionAuth({
			authMode: 'device-auth',
			apiKey: 'sk-test',
			codexHome
		});

		expect(auth).toEqual({
			mode: 'device-auth',
			codexHome,
			env: { CODEX_HOME: codexHome }
		});
		expect(mockVerifyDeviceAuthConnection).toHaveBeenCalledWith(codexHome);
	});

	it('derives a managed per-user codex home when userId is provided', async () => {
		const userId = 'user/1';

		expect(resolveCodexHome({}, userId)).toBe(getManagedCodexHome(userId));

		const auth = await resolveExecutionAuth({ authMode: 'device-auth' }, userId);
		expect(auth).toBeNull();
	});

	it('returns explicit device-auth when scoped auth exists', async () => {
		const userId = 'user/1';
		const codexHome = getManagedCodexHome(userId);
		await fs.mkdir(codexHome, { recursive: true });
		await fs.writeFile(path.join(codexHome, 'auth.json'), '{"ok":true}', 'utf-8');
		tempDirs.push(path.dirname(codexHome));

		const auth = await resolveExecutionAuth({ authMode: 'device-auth' }, userId);
		expect(auth).toEqual({
			mode: 'device-auth',
			codexHome,
			env: { CODEX_HOME: codexHome }
		});
	});

	it('falls back to device auth when api-key mode has no key but auth.json exists', async () => {
		const codexHome = await makeTempDir();
		await fs.writeFile(path.join(codexHome, 'auth.json'), '{"ok":true}', 'utf-8');

		const auth = await resolveExecutionAuth({ authMode: 'api-key', codexHome });
		expect(auth).toEqual({
			mode: 'device-auth',
			codexHome,
			env: { CODEX_HOME: codexHome }
		});
	});

	it('returns null when api-key mode has no key and no device auth exists', async () => {
		const codexHome = await makeTempDir();
		expect(await resolveExecutionAuth({ authMode: 'api-key', codexHome })).toBeNull();
	});

	it('detects Codex device auth from auth.json', async () => {
		const codexHome = await makeTempDir();
		await fs.writeFile(path.join(codexHome, 'auth.json'), '{"ok":true}', 'utf-8');

		expect(resolveCodexHome({ codexHome })).toBe(codexHome);
		expect(await hasDeviceCodexAuth({ codexHome })).toBe(true);

		const auth = await resolveExecutionAuth({ codexHome });
		expect(auth).toEqual({
			mode: 'device-auth',
			codexHome,
			env: { CODEX_HOME: codexHome }
		});
	});

	it('checks the managed per-user auth path when userId is provided', async () => {
		const userId = 'user-2';
		const codexHome = getManagedCodexHome(userId);
		await fs.mkdir(codexHome, { recursive: true });
		await fs.writeFile(path.join(codexHome, 'auth.json'), '{"ok":true}', 'utf-8');
		tempDirs.push(path.dirname(codexHome));

		expect(await hasDeviceCodexAuth({}, userId)).toBe(true);
		expect(await resolveExecutionAuth({}, userId)).toEqual({
			mode: 'device-auth',
			codexHome,
			env: { CODEX_HOME: codexHome }
		});
	});

	it('does not fall back to host-global device auth when unscoped fallback is disabled', async () => {
		const codexHome = await makeTempDir();
		await fs.writeFile(path.join(codexHome, 'auth.json'), '{"ok":true}', 'utf-8');
		const previousCodexHome = process.env.CODEX_HOME;
		process.env.CODEX_HOME = codexHome;

		try {
			expect(await hasDeviceCodexAuth({}, undefined, { allowHostFallback: false })).toBe(false);
			expect(
				await resolveExecutionAuth({ authMode: 'device-auth' }, undefined, { allowHostFallback: false })
			).toBeNull();
			expect(await resolveExecutionAuth({}, undefined, { allowHostFallback: false })).toBeNull();
		} finally {
			if (previousCodexHome === undefined) {
				delete process.env.CODEX_HOME;
			} else {
				process.env.CODEX_HOME = previousCodexHome;
			}
		}
	});

	it('returns null when no api key or device auth is available', async () => {
		const codexHome = await makeTempDir();

		expect(await hasDeviceCodexAuth({ codexHome })).toBe(false);
		expect(mockVerifyDeviceAuthConnection).toHaveBeenCalledWith(codexHome);
		expect(await resolveExecutionAuth({ codexHome })).toBeNull();
	});

	it('tracks completed and failed steps in pipeline state', () => {
		let state = initializeState();

		state = updateStepState(state, 'setup-codex', 'running');
		state = updateStepState(state, 'setup-codex', 'completed');
		state = updateStepState(state, 'generate-items', 'running');
		state = updateStepState(state, 'generate-items', 'failed', 'boom');

		expect(state.completedSteps).toContain('setup-codex');
		expect(state.failedSteps).toContain('generate-items');
		expect(state.steps.get('generate-items')?.error).toBe('boom');
	});
});

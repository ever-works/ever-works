import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	DEVICE_AUTH_AUTH_JSON_SETTING,
	cleanupDeviceAuthHome,
	hasDeviceCodexAuth,
	initializeState,
	materializeDeviceAuthHome,
	resolveExecutionAuth,
	updateStepState
} from '../utils/pipeline-helpers.js';

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
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
		const auth = await resolveExecutionAuth({
			authMode: 'device-auth',
			apiKey: 'sk-test',
			[DEVICE_AUTH_AUTH_JSON_SETTING]: '{"ok":true}'
		});

		expect(auth).toEqual({
			mode: 'device-auth',
			authJson: '{"ok":true}'
		});
	});

	it('returns explicit device-auth when a portable auth payload exists', async () => {
		expect(
			await resolveExecutionAuth({
				authMode: 'device-auth',
				[DEVICE_AUTH_AUTH_JSON_SETTING]: '{"token":"abc"}'
			})
		).toEqual({
			mode: 'device-auth',
			authJson: '{"token":"abc"}'
		});
	});

	it('falls back to device auth when api-key mode has no key but a portable auth payload exists', async () => {
		expect(
			await resolveExecutionAuth({
				authMode: 'api-key',
				[DEVICE_AUTH_AUTH_JSON_SETTING]: '{"token":"abc"}'
			})
		).toEqual({
			mode: 'device-auth',
			authJson: '{"token":"abc"}'
		});
	});

	it('returns null when no api key or device auth payload is available', async () => {
		expect(await hasDeviceCodexAuth({})).toBe(false);
		expect(await resolveExecutionAuth({})).toBeNull();
	});

	it('materializes and cleans up a per-run device-auth home', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-device-auth-home-'));
		tempDirs.push(tempRoot);

		const codexHome = await materializeDeviceAuthHome('{"token":"abc"}', tempRoot);
		expect(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf-8')).toBe('{"token":"abc"}');

		await cleanupDeviceAuthHome(codexHome);
		await expect(fs.stat(codexHome)).rejects.toThrow();
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

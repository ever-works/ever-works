import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	hasLocalCodexAuth,
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

describe('pipeline-helpers', () => {
	it('prefers api key auth when provided', async () => {
		const auth = await resolveExecutionAuth({ apiKey: 'sk-test' });

		expect(auth).toEqual({
			mode: 'api-key',
			env: { OPENAI_API_KEY: 'sk-test' }
		});
	});

	it('detects local Codex auth from auth.json', async () => {
		const codexHome = await makeTempDir();
		await fs.writeFile(path.join(codexHome, 'auth.json'), '{"ok":true}', 'utf-8');

		expect(resolveCodexHome({ codexHome })).toBe(codexHome);
		expect(await hasLocalCodexAuth({ codexHome })).toBe(true);

		const auth = await resolveExecutionAuth({ codexHome });
		expect(auth).toEqual({
			mode: 'local',
			codexHome,
			env: { CODEX_HOME: codexHome }
		});
	});

	it('returns null when no api key or local auth is available', async () => {
		const codexHome = await makeTempDir();

		expect(await hasLocalCodexAuth({ codexHome })).toBe(false);
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

import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { validateSettingsConstraints, type PluginSettingsSchemaProperty } from '@ever-works/plugin/api';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

import { GeminiPlugin } from '../gemini.plugin';
import { DEFAULT_CLI_VERSION, DEFAULT_MODEL } from '../types';
import { executeGemini } from '../utils/process-runner';

/**
 * Models refresh (2026-11-05). Sources: https://aistudio.google.com/docs/models,
 * https://aistudio.google.com/docs/deprecations and https://github.com/google-gemini/gemini-cli.
 */

// Copied from packages/agent/src/works-config/services/works-config-import-applier.service.ts
// (SAFE_PIPELINE_MODEL_PATTERN). A works-config import rejects any pipeline model id outside it.
const SAFE_PIPELINE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const CURRENT_IDS = [
	'gemini-4-argon',
	'gemini-3.8-flash',
	'gemini-3.6-flash',
	'gemini-3.5-flash-lite',
	'gemini-3.1-pro-preview',
	'gemini-3-flash-preview'
];
const LEGACY_IDS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

function semverAtLeast(version: string, minimum: string): boolean {
	const a = version.split('.').map(Number);
	const b = minimum.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) {
			return a[i] > b[i];
		}
	}
	return true;
}

async function runAndCaptureArgs(model?: string): Promise<string[]> {
	const child = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: vi.fn(),
		killed: false
	});
	spawnMock.mockReturnValueOnce(child);
	const { promise } = executeGemini({
		command: 'gemini',
		commandArgs: [],
		prompt: 'Generate items',
		systemPrompt: 'system prompt',
		cwd: '/tmp/work',
		env: { GEMINI_API_KEY: 'scoped-key' },
		model
	});
	child.emit('exit', 0);
	await promise;
	return spawnMock.mock.calls.at(-1)?.[1] as string[];
}

describe('gemini CLI model catalog (models refresh 2026-11-05)', () => {
	const plugin = new GeminiPlugin();

	beforeEach(() => {
		spawnMock.mockReset();
	});

	it('lists the current Gemini API models, then the still-served legacy ids', async () => {
		const models = await plugin.listModels();
		expect(models.map((m) => m.id)).toEqual([...CURRENT_IDS, ...LEGACY_IDS]);
	});

	it('gives every listed model the documented 1,048,576 input / 65,536 output limits', async () => {
		for (const model of await plugin.listModels()) {
			expect(model.capabilities.maxContextLength, model.id).toBe(1_048_576);
			expect(model.capabilities.maxOutputTokens, model.id).toBe(65_536);
		}
	});

	it('labels the 2.5 ids as legacy and drops the shut-down 3.1 Flash-Lite preview', async () => {
		const models = await plugin.listModels();
		for (const id of LEGACY_IDS) {
			expect(models.find((m) => m.id === id)?.name, id).toContain('(legacy)');
		}
		for (const id of ['gemini-3.1-pro-preview', 'gemini-3-flash-preview']) {
			expect(models.find((m) => m.id === id)?.name, id).toContain('(Preview)');
		}
		// Shut down 2026-05-25. It stays usable as free text (see below).
		expect(models.map((m) => m.id)).not.toContain('gemini-3.1-flash-lite-preview');
	});

	it('keeps every listed id inside the works-config pipeline model pattern', async () => {
		for (const model of await plugin.listModels()) {
			expect(model.id, model.id).toMatch(SAFE_PIPELINE_MODEL_PATTERN);
		}
	});

	it('defaults to gemini-3.8-flash, which is in the list and is the schema default', async () => {
		expect(DEFAULT_MODEL).toBe('gemini-3.8-flash');
		expect((await plugin.listModels()).map((m) => m.id)).toContain(DEFAULT_MODEL);
		expect(plugin.settingsSchema.properties?.model?.default).toBe(DEFAULT_MODEL);
		expect(plugin.settingsSchema.properties?.model?.enum).toBeUndefined();
	});

	// Gemini CLI 0.45.2 silently rewrote any id ending in "flash" to its own default
	// (google-gemini/gemini-cli#28859, fixed in 0.61.0); native 3.8 Flash arrived in 0.62.0.
	it('pins a Gemini CLI that passes the chosen model through (0.67.0)', () => {
		expect(DEFAULT_CLI_VERSION).toBe('0.67.0');
		expect(semverAtLeast(DEFAULT_CLI_VERSION, '0.62.0')).toBe(true);
	});

	describe('previously shipped ids keep working as free text', () => {
		it.each(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.1-flash-lite-preview'])(
			'%s passes settings validation',
			(model) => {
				expect(plugin.validateSettings({ apiKey: 'test-key', model }).valid).toBe(true);
				const properties = plugin.settingsSchema.properties as Record<string, PluginSettingsSchemaProperty>;
				expect(validateSettingsConstraints({ model }, properties)).toEqual([]);
			}
		);

		it.each(['gemini-2.5-flash', 'gemini-3.1-flash-lite-preview', 'gemini-3.8-flash'])(
			'%s reaches the CLI --model flag unchanged',
			async (model) => {
				const args = await runAndCaptureArgs(model);
				expect(args[args.indexOf('--model') + 1]).toBe(model);
			}
		);
	});

	it('uses --approval-mode yolo, never the deprecated --yolo flag', async () => {
		const args = await runAndCaptureArgs('gemini-3.8-flash');
		expect(args[args.indexOf('--approval-mode') + 1]).toBe('yolo');
		expect(args).not.toContain('--yolo');
		expect(args).not.toContain('-y');
	});
});

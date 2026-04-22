import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'node:crypto';

import type { PluginSettings } from '@ever-works/plugin';
import { createPipelineRuntimeHelpers } from '@ever-works/plugin';

import type { CodexStepId } from '../types.js';
import { CODEX_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';
export { getManagedCodexHome, resolveCodexHome } from './codex-home.js';

export const DEVICE_AUTH_AUTH_JSON_SETTING = 'deviceAuthAuthJson';

export type ResolvedExecutionAuth =
	| {
			readonly env: Record<string, string>;
			readonly mode: 'api-key';
	  }
	| {
			readonly authJson: string;
			readonly mode: 'device-auth';
	  };

const runtime = createPipelineRuntimeHelpers<CodexStepId>({
	stepDefinitions: STEP_DEFINITIONS,
	totalSteps: CODEX_STEP_IDS.length
});

export const initializeState = runtime.initializeState;
export const updateStepState = runtime.updateStepState;
export const reportProgress = runtime.reportProgress;
export const reportItemProgress = runtime.reportItemProgress;
export const resolveSettings = runtime.resolveSettings;
export const buildMetrics = runtime.buildMetrics;
export const buildErrorResult = runtime.buildErrorResult;
export const buildCancelledResult = runtime.buildCancelledResult;
export const delay = runtime.delay;

function getUsableSecret(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed || trimmed.includes('••••')) {
		return undefined;
	}

	return trimmed;
}

export function getPortableDeviceAuthJson(settings: PluginSettings): string | undefined {
	return getUsableSecret(settings[DEVICE_AUTH_AUTH_JSON_SETTING]);
}

export async function hasDeviceCodexAuth(settings: PluginSettings): Promise<boolean> {
	return Boolean(getPortableDeviceAuthJson(settings));
}

export async function resolveExecutionAuth(settings: PluginSettings): Promise<ResolvedExecutionAuth | null> {
	const authMode = typeof settings.authMode === 'string' ? settings.authMode : undefined;
	const apiKey = getUsableSecret(settings.apiKey);
	const deviceAuthAuthJson = getPortableDeviceAuthJson(settings);

	if (authMode === 'api-key' && apiKey) {
		return {
			mode: 'api-key',
			env: { OPENAI_API_KEY: apiKey }
		};
	}

	if (authMode === 'device-auth') {
		if (!deviceAuthAuthJson) {
			return null;
		}
		return {
			mode: 'device-auth',
			authJson: deviceAuthAuthJson
		};
	}

	if (apiKey) {
		return {
			mode: 'api-key',
			env: { OPENAI_API_KEY: apiKey }
		};
	}

	if (deviceAuthAuthJson) {
		return {
			mode: 'device-auth',
			authJson: deviceAuthAuthJson
		};
	}

	return null;
}

export async function materializeDeviceAuthHome(authJson: string, baseDir?: string): Promise<string> {
	const rootDir = baseDir
		? path.resolve(baseDir)
		: await fs.mkdtemp(path.join(os.tmpdir(), `ever-works-codex-auth-${randomUUID()}-`));
	const codexHome = path.join(rootDir, '.codex');

	await fs.mkdir(codexHome, { recursive: true });
	await fs.writeFile(path.join(codexHome, 'auth.json'), authJson, 'utf-8');

	return codexHome;
}

export async function cleanupDeviceAuthHome(codexHome: string): Promise<void> {
	try {
		await fs.rm(path.dirname(codexHome), { recursive: true, force: true });
	} catch {
		// Cleanup failures are non-fatal.
	}
}

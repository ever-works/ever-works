import * as fs from 'fs/promises';
import * as path from 'path';

import type { PluginSettings } from '@ever-works/plugin';
import { createPipelineRuntimeHelpers } from '@ever-works/plugin';

import type { CodexStepId } from '../types.js';
import { CODEX_STEP_IDS } from '../types.js';
import { STEP_DEFINITIONS } from '../steps.js';
import { verifyDeviceAuthConnection } from '../device-auth.js';
import { resolveCodexHome } from './codex-home.js';
export { getManagedCodexHome, resolveCodexHome } from './codex-home.js';

export interface ResolvedExecutionAuth {
	readonly env: Record<string, string>;
	readonly mode: 'api-key' | 'device-auth';
	readonly codexHome?: string;
}

export interface DeviceAuthResolutionOptions {
	readonly allowHostFallback?: boolean;
}

function hasConfiguredCodexHome(settings: PluginSettings): boolean {
	return typeof settings.codexHome === 'string' && settings.codexHome.trim().length > 0;
}

function shouldUseHostFallback(
	settings: PluginSettings,
	userId: string | undefined,
	options?: DeviceAuthResolutionOptions
): boolean {
	if (userId || hasConfiguredCodexHome(settings)) {
		return true;
	}

	return options?.allowHostFallback !== false;
}

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

export async function hasDeviceCodexAuth(
	settings: PluginSettings,
	userId?: string,
	options?: DeviceAuthResolutionOptions
): Promise<boolean> {
	if (!shouldUseHostFallback(settings, userId, options)) {
		return false;
	}

	const codexHome = resolveCodexHome(settings, userId);
	const authPath = path.join(codexHome, 'auth.json');
	try {
		const stats = await fs.stat(authPath);
		if (stats.isFile()) {
			return true;
		}
	} catch {
		// Fall back to Codex CLI status below.
	}

	return verifyDeviceAuthConnection(codexHome);
}

export async function resolveExecutionAuth(
	settings: PluginSettings,
	userId?: string,
	options?: DeviceAuthResolutionOptions
): Promise<ResolvedExecutionAuth | null> {
	const authMode = typeof settings.authMode === 'string' ? settings.authMode : undefined;
	const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey.trim() : '';

	if (authMode === 'api-key' && apiKey) {
		return {
			mode: 'api-key',
			env: { OPENAI_API_KEY: apiKey }
		};
	}

	if (authMode === 'device-auth') {
		const codexHome = resolveCodexHome(settings, userId);
		if (!(await hasDeviceCodexAuth(settings, userId, options))) {
			return null;
		}
		return {
			mode: 'device-auth',
			codexHome,
			env: {
				CODEX_HOME: codexHome
			}
		};
	}

	if (apiKey) {
		return {
			mode: 'api-key',
			env: { OPENAI_API_KEY: apiKey }
		};
	}

	if (await hasDeviceCodexAuth(settings, userId, options)) {
		const codexHome = resolveCodexHome(settings, userId);
		return {
			mode: 'device-auth',
			codexHome,
			env: {
				CODEX_HOME: codexHome
			}
		};
	}

	return null;
}

import * as os from 'os';
import * as path from 'path';

import type { PluginSettings } from '@ever-works/plugin';

import { BASE_TEMP_DIR } from '../types.js';

function sanitizeUserId(userId: string): string {
	return userId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function getManagedCodexHome(userId: string): string {
	return path.join(BASE_TEMP_DIR, 'auth', sanitizeUserId(userId), '.codex');
}

export function resolveCodexHome(settings: PluginSettings, userId?: string): string {
	const configured = typeof settings.codexHome === 'string' ? settings.codexHome.trim() : '';
	if (configured) {
		return configured;
	}

	if (userId) {
		return getManagedCodexHome(userId);
	}

	return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

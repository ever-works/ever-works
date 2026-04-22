import * as os from 'os';
import * as path from 'path';

import type { PluginSettings } from '@ever-works/plugin';

function sanitizeUserId(userId: string): string {
	return userId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isWithinTempDir(targetPath: string): boolean {
	const resolvedTarget = path.resolve(targetPath);
	const resolvedTempDir = path.resolve(os.tmpdir());

	return resolvedTarget === resolvedTempDir || resolvedTarget.startsWith(`${resolvedTempDir}${path.sep}`);
}

function getManagedCodexBaseDir(): string {
	const configuredDataDir = process.env.EVER_WORKS_DATA_DIR?.trim();
	if (configuredDataDir && !isWithinTempDir(configuredDataDir)) {
		return path.join(configuredDataDir, 'codex');
	}

	return path.join(os.homedir(), '.ever-works', 'codex');
}

export function getManagedCodexHome(userId: string): string {
	return path.join(getManagedCodexBaseDir(), 'auth', sanitizeUserId(userId), '.codex');
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

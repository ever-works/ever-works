import * as os from 'os';
import * as path from 'path';

import type { PluginSettings } from '@ever-works/plugin';

function sanitizeUserId(userId: string): string {
	return userId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isWithinDir(targetPath: string, baseDir: string): boolean {
	const resolvedTarget = path.resolve(targetPath);
	const resolvedBase = path.resolve(baseDir);

	return resolvedTarget === resolvedBase || resolvedTarget.startsWith(`${resolvedBase}${path.sep}`);
}

function isWithinTempDir(targetPath: string): boolean {
	return isWithinDir(targetPath, os.tmpdir());
}

// Security (path-traversal): allowlist the roots an operator-supplied `codexHome`
// override may resolve into. The override flows into `CODEX_HOME` for the Codex
// subprocess and into the auth-credential write path, so an unconfined value
// (e.g. `/home/app/.ssh`, `/etc`) would let a caller read/write credentials at an
// attacker-chosen location. Confine it to the managed data dir, the user home, or
// the temp dir (where device-auth homes are materialized); anything else is ignored.
function isAllowedCodexHomeOverride(targetPath: string): boolean {
	const allowedRoots = [os.homedir(), os.tmpdir()];

	const configuredDataDir = process.env.EVER_WORKS_DATA_DIR?.trim();
	if (configuredDataDir) {
		allowedRoots.push(configuredDataDir);
	}

	return allowedRoots.some((root) => isWithinDir(targetPath, root));
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
	// Security (path-traversal): only honor the override when it stays within an allowed
	// root; otherwise drop it and fall through to the managed/default home so a hostile
	// `codexHome` cannot redirect credential writes or the subprocess CWD to an arbitrary path.
	if (configured && isAllowedCodexHomeOverride(configured)) {
		return configured;
	}

	if (userId) {
		return getManagedCodexHome(userId);
	}

	return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

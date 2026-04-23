import * as fs from 'fs/promises';
import * as path from 'path';
import { BASE_TEMP_DIR } from '../types.js';
import {
	cleanupWorkspace as cleanupCliWorkspace,
	collectMetadataFromItems,
	createWorkspace as createCliWorkspace,
	getWorkspacePath as getCliWorkspacePath,
	readGeneratedItems as readCliGeneratedItems,
	seedExistingItems as seedCliExistingItems,
	seedMetadata as seedCliMetadata,
	slugify,
	unslugify
} from '@ever-works/plugin/cli-pipeline';

export { collectMetadataFromItems, slugify, unslugify };

interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug?(message: string, ...args: unknown[]): void;
}

export function getWorkspacePath(userId: string, directoryId: string): string {
	return getCliWorkspacePath(BASE_TEMP_DIR, userId, directoryId);
}

export function createWorkspace(userId: string, directoryId: string): Promise<string> {
	return createCliWorkspace(BASE_TEMP_DIR, userId, directoryId);
}

export const seedExistingItems = seedCliExistingItems;
export const seedMetadata = seedCliMetadata;

export function readGeneratedItems(workspacePath: string, logger?: Logger) {
	return readCliGeneratedItems(workspacePath, logger);
}

export async function ensureOnboardingConfig(configDir: string): Promise<void> {
	const settingsDir = path.join(configDir, '.gemini');
	const settingsPath = path.join(settingsDir, 'settings.json');
	await fs.mkdir(settingsDir, { recursive: true });
	await fs.mkdir(path.join(configDir, '.config'), { recursive: true });
	await fs.mkdir(path.join(configDir, '.local', 'share'), { recursive: true });
	await fs.mkdir(path.join(configDir, '.cache'), { recursive: true });

	let existingConfig: Record<string, unknown> = {};
	try {
		existingConfig = JSON.parse(await fs.readFile(settingsPath, 'utf-8')) as Record<string, unknown>;
	} catch {
		// No existing config yet.
	}

	const nextConfig = {
		...existingConfig,
		general: {
			...(typeof existingConfig.general === 'object' && existingConfig.general !== null
				? (existingConfig.general as Record<string, unknown>)
				: {}),
			disableAutoUpdate: true,
			disableUpdateNag: true,
			checkpointing: {
				...(typeof (existingConfig.general as { checkpointing?: unknown } | undefined)?.checkpointing ===
					'object' &&
				(existingConfig.general as { checkpointing?: unknown } | undefined)?.checkpointing !== null
					? ((existingConfig.general as { checkpointing?: Record<string, unknown> }).checkpointing ?? {})
					: {}),
				enabled: false
			}
		},
		tools: {
			...(typeof existingConfig.tools === 'object' && existingConfig.tools !== null
				? (existingConfig.tools as Record<string, unknown>)
				: {}),
			sandbox: true
		}
	};

	if (JSON.stringify(existingConfig) === JSON.stringify(nextConfig)) {
		return;
	}

	await fs.writeFile(settingsPath, JSON.stringify(nextConfig, null, 2), 'utf-8');
}

export const cleanupWorkspace = cleanupCliWorkspace;

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

const HEADLESS_CONFIG: Record<string, unknown> = {
	hasCompletedOnboarding: true,
	bypassPermissionsModeAccepted: true,
	hasTrustDialogHooksAccepted: true,
	autoUpdates: false
};

export async function ensureOnboardingConfig(configDir: string): Promise<void> {
	const configPath = path.join(configDir, '.claude.json');
	let config: Record<string, unknown>;

	try {
		const content = await fs.readFile(configPath, 'utf-8');
		config = JSON.parse(content) as Record<string, unknown>;
	} catch {
		await fs.mkdir(configDir, { recursive: true });
		config = {};
	}

	const dirty = Object.entries(HEADLESS_CONFIG).some(([key, value]) => config[key] !== value);
	if (!dirty) {
		return;
	}

	Object.assign(config, HEADLESS_CONFIG);
	await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export const cleanupWorkspace = cleanupCliWorkspace;

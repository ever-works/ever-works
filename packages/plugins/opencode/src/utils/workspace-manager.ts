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

export const cleanupWorkspace = cleanupCliWorkspace;

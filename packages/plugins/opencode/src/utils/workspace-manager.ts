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

export function getWorkspacePath(userId: string, workId: string): string {
	return getCliWorkspacePath(BASE_TEMP_DIR, userId, workId);
}

export function createWorkspace(userId: string, workId: string): Promise<string> {
	return createCliWorkspace(BASE_TEMP_DIR, userId, workId);
}

export const seedExistingItems = seedCliExistingItems;
export const seedMetadata = seedCliMetadata;

export function readGeneratedItems(workspacePath: string, logger?: Logger) {
	return readCliGeneratedItems(workspacePath, logger);
}

export const cleanupWorkspace = cleanupCliWorkspace;

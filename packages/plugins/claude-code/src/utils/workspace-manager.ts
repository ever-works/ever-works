import * as fs from 'fs/promises';
import * as path from 'path';
import { BASE_TEMP_DIR } from '../types.js';
import type { ItemData, Category, Tag, Brand } from '@ever-works/plugin';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

/**
 * Generate a slug from a name.
 * Lowercase, replace spaces/special chars with hyphens, strip non-alphanumeric.
 */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s_-]/g, '')
		.replace(/[\s_]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

/**
 * Deduplicate slugs by appending an index for collisions.
 */
function deduplicateSlug(slug: string, existingSlugs: Set<string>): string {
	if (!existingSlugs.has(slug)) {
		return slug;
	}
	let index = 2;
	while (existingSlugs.has(`${slug}-${index}`)) {
		index++;
	}
	return `${slug}-${index}`;
}

/**
 * Get the workspace path for a user+directory combination.
 */
export function getWorkspacePath(userId: string, directoryId: string): string {
	return path.join(BASE_TEMP_DIR, userId, directoryId);
}

/**
 * Create a fresh workspace directory with _meta/ subdirectory.
 * Removes any existing workspace first.
 */
export async function createWorkspace(userId: string, directoryId: string): Promise<string> {
	const workspacePath = getWorkspacePath(userId, directoryId);

	// Clean up any existing workspace
	await fs.rm(workspacePath, { recursive: true, force: true });

	// Create workspace and metadata directory
	await fs.mkdir(path.join(workspacePath, '_meta'), { recursive: true });

	return workspacePath;
}

/**
 * Seed existing items as individual JSON files in the workspace root.
 * Each file is named {slug}.json.
 */
export async function seedExistingItems(workspacePath: string, items: readonly ItemData[]): Promise<void> {
	if (!items.length) return;

	const usedSlugs = new Set<string>();

	for (const item of items) {
		const baseSlug = item.slug || slugify(item.name);
		const slug = deduplicateSlug(baseSlug, usedSlugs);
		usedSlugs.add(slug);

		const filePath = path.join(workspacePath, `${slug}.json`);
		await fs.writeFile(filePath, JSON.stringify(item, null, 2), 'utf-8');
	}
}

/**
 * Seed metadata files into the _meta/ subdirectory.
 */
export async function seedMetadata(
	workspacePath: string,
	metadata: {
		directory?: { name: string; description?: string };
		request?: { prompt?: string; name?: string };
		categories?: readonly Category[];
		tags?: readonly Tag[];
		brands?: readonly Brand[];
	}
): Promise<void> {
	const metaDir = path.join(workspacePath, '_meta');

	if (metadata.directory) {
		await fs.writeFile(path.join(metaDir, 'directory.json'), JSON.stringify(metadata.directory, null, 2), 'utf-8');
	}

	if (metadata.request) {
		await fs.writeFile(path.join(metaDir, 'request.json'), JSON.stringify(metadata.request, null, 2), 'utf-8');
	}

	if (metadata.categories?.length) {
		await fs.writeFile(
			path.join(metaDir, 'categories.json'),
			JSON.stringify(metadata.categories, null, 2),
			'utf-8'
		);
	}

	if (metadata.tags?.length) {
		await fs.writeFile(path.join(metaDir, 'tags.json'), JSON.stringify(metadata.tags, null, 2), 'utf-8');
	}

	if (metadata.brands?.length) {
		await fs.writeFile(path.join(metaDir, 'brands.json'), JSON.stringify(metadata.brands, null, 2), 'utf-8');
	}
}

/**
 * Read all generated item JSON files from the workspace root.
 * Skips _meta/ directory and invalid JSON files.
 * Validates required fields: name, description, source_url, category.
 */
export async function readGeneratedItems(workspacePath: string, logger?: Logger): Promise<ItemData[]> {
	const entries = await fs.readdir(workspacePath, { withFileTypes: true });
	const items: ItemData[] = [];

	for (const entry of entries) {
		// Skip directories (like _meta/) and non-JSON files
		if (entry.isDirectory() || !entry.name.endsWith('.json')) {
			continue;
		}

		const filePath = path.join(workspacePath, entry.name);
		try {
			const content = await fs.readFile(filePath, 'utf-8');
			const data = JSON.parse(content);

			// Validate required fields
			if (!data.name || !data.description || !data.source_url || !data.category) {
				logger?.warn(
					`Skipping ${entry.name}: missing required fields (name, description, source_url, category)`
				);
				continue;
			}

			// Ensure tags is an array
			if (!Array.isArray(data.tags)) {
				data.tags = [];
			}

			items.push(data as ItemData);
		} catch (err) {
			logger?.warn(`Skipping ${entry.name}: ${err instanceof Error ? err.message : 'invalid JSON'}`);
		}
	}

	return items;
}

/**
 * Read generated metadata files from _meta/ directory.
 * Returns empty arrays for missing files.
 */
export async function readGeneratedMetadata(workspacePath: string): Promise<{
	categories: Category[];
	tags: Tag[];
	brands: Brand[];
}> {
	const metaDir = path.join(workspacePath, '_meta');
	const result = { categories: [] as Category[], tags: [] as Tag[], brands: [] as Brand[] };

	for (const [key, filename] of [
		['categories', 'categories.json'],
		['tags', 'tags.json'],
		['brands', 'brands.json']
	] as const) {
		try {
			const content = await fs.readFile(path.join(metaDir, filename), 'utf-8');
			const parsed = JSON.parse(content);
			if (Array.isArray(parsed)) {
				result[key] = parsed;
			}
		} catch {
			// File doesn't exist or is invalid - return empty array
		}
	}

	return result;
}

/**
 * Required global flags for headless Claude Code execution.
 * See: https://github.com/anthropics/claude-code/issues/8938
 */
const HEADLESS_GLOBAL_FLAGS: Record<string, unknown> = {
	hasCompletedOnboarding: true,
	bypassPermissionsModeAccepted: true,
	hasTrustDialogHooksAccepted: true,
	autoUpdates: false,
};

/**
 * Required per-project flags for headless execution.
 * The workspace path is used as the project key.
 */
const HEADLESS_PROJECT_FLAGS: Record<string, unknown> = {
	allowedTools: [],
	hasTrustDialogAccepted: true,
};

/**
 * Ensure .claude.json has all flags needed for non-interactive execution.
 *
 * CLAUDE_CODE_CONFIG_DIR points to a per-user directory. Claude Code
 * reads .claude.json from there and will prompt for onboarding, trust
 * dialogs, and hooks acceptance unless the right flags are set.
 *
 * @param configDir  Per-user config directory (CLAUDE_CODE_CONFIG_DIR)
 * @param workspacePath  Absolute path to the workspace (cwd for the CLI)
 */
export async function ensureOnboardingConfig(configDir: string, workspacePath: string): Promise<void> {
	const configPath = path.join(configDir, '.claude.json');
	let config: Record<string, unknown>;

	try {
		const content = await fs.readFile(configPath, 'utf-8');
		config = JSON.parse(content) as Record<string, unknown>;
	} catch {
		// File doesn't exist or is invalid — start fresh
		await fs.mkdir(configDir, { recursive: true });
		config = {};
	}

	// Check if all global flags are already set
	const globalDirty = Object.entries(HEADLESS_GLOBAL_FLAGS).some(
		([key, value]) => config[key] !== value,
	);

	// Check per-project flags
	const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
	const projectConfig = projects[workspacePath] ?? {};
	const projectDirty = Object.entries(HEADLESS_PROJECT_FLAGS).some(
		([key, value]) => JSON.stringify(projectConfig[key]) !== JSON.stringify(value),
	);

	if (!globalDirty && !projectDirty) {
		return; // Already fully configured
	}

	// Apply global flags
	Object.assign(config, HEADLESS_GLOBAL_FLAGS);

	// Apply per-project flags
	projects[workspacePath] = { ...projectConfig, ...HEADLESS_PROJECT_FLAGS };
	config.projects = projects;

	await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Clean up the workspace directory. Never throws.
 */
export async function cleanupWorkspace(userId: string, directoryId: string): Promise<void> {
	try {
		const workspacePath = getWorkspacePath(userId, directoryId);
		await fs.rm(workspacePath, { recursive: true, force: true });
	} catch {
		// Cleanup failures are non-fatal
	}
}

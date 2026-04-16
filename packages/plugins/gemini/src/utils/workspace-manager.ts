import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { BASE_TEMP_DIR } from '../types.js';
import type { ItemData, Category, Tag, Brand } from '@ever-works/plugin';
import {
	slugify,
	collectMetadataFromItems,
	validateRequiredItemFields,
	normalizeItemTags,
	jsonrepair
} from '@ever-works/plugin';

// Re-export shared utilities so existing imports continue to work
export { slugify, unslugify, collectMetadataFromItems } from '@ever-works/plugin';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug?(message: string, ...args: unknown[]): void;
}

/** Max concurrent file writes to avoid fd exhaustion. */
const WRITE_CONCURRENCY = 64;

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
 * Run async tasks with bounded concurrency.
 */
async function parallelBatch<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
	const results: T[] = [];
	for (let i = 0; i < tasks.length; i += concurrency) {
		const batch = tasks.slice(i, i + concurrency);
		results.push(...(await Promise.all(batch.map((fn) => fn()))));
	}
	return results;
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
 * Seed existing items as individual JSON files + JSONL dedup index + hash manifest.
 */
export async function seedExistingItems(workspacePath: string, items: readonly ItemData[]): Promise<void> {
	if (!items.length) return;

	const metaDir = path.join(workspacePath, '_meta');
	const usedSlugs = new Set<string>();
	const seededManifest: Record<string, string> = {};
	const indexLines: string[] = [];
	const itemWrites: (() => Promise<void>)[] = [];

	for (const item of items) {
		const baseSlug = item.slug || slugify(item.name);
		const slug = deduplicateSlug(baseSlug, usedSlugs);
		usedSlugs.add(slug);

		const fileName = `${slug}.json`;
		const content = JSON.stringify(item, null, 2);
		seededManifest[fileName] = createHash('sha256').update(content).digest('hex');
		indexLines.push(JSON.stringify({ slug, name: item.name, source_url: item.source_url }));

		itemWrites.push(() => fs.writeFile(path.join(workspacePath, fileName), content, 'utf-8'));
	}

	await parallelBatch(itemWrites, WRITE_CONCURRENCY);

	await Promise.all([
		fs.writeFile(path.join(metaDir, 'seeded.json'), JSON.stringify(seededManifest), 'utf-8'),
		fs.writeFile(path.join(metaDir, 'existing-items.jsonl'), indexLines.join('\n') + '\n', 'utf-8')
	]);
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
 * Read generated/modified items from workspace. Skips unchanged seeded files via content hash.
 */
export async function readGeneratedItems(workspacePath: string, logger?: Logger): Promise<ItemData[]> {
	let entries: string[];
	try {
		const dirEntries = await fs.readdir(workspacePath, { withFileTypes: true });
		entries = dirEntries.filter((e) => !e.isDirectory() && e.name.endsWith('.json')).map((e) => e.name);
	} catch {
		logger?.warn('Could not read workspace directory');
		return [];
	}

	if (entries.length === 0) return [];

	let seededHashes: Record<string, string> = {};
	try {
		const manifestContent = await fs.readFile(path.join(workspacePath, '_meta', 'seeded.json'), 'utf-8');
		seededHashes = JSON.parse(manifestContent) as Record<string, string>;
	} catch {
		// No manifest — treat all files as new
	}

	const results = await Promise.all(
		entries.map(async (fileName) => {
			try {
				const content = await fs.readFile(path.join(workspacePath, fileName), 'utf-8');

				const seededHash = seededHashes[fileName];
				if (seededHash) {
					const currentHash = createHash('sha256').update(content).digest('hex');
					if (currentHash === seededHash) {
						return null;
					}
				}

				let data;
				try {
					data = JSON.parse(content);
				} catch {
					const repaired = jsonrepair(content);
					data = JSON.parse(repaired);
					logger?.warn(`Repaired malformed JSON in ${fileName}`);
				}

				if (!validateRequiredItemFields(data)) {
					logger?.warn(
						`Skipping ${fileName}: missing required fields (name, description, source_url, category)`
					);
					return null;
				}

				normalizeItemTags(data);
				return data as ItemData;
			} catch (err) {
				logger?.warn(`Skipping ${fileName}: ${err instanceof Error ? err.message : 'invalid JSON'}`);
				return null;
			}
		})
	);

	return results.filter((item): item is ItemData => item !== null);
}

/**
 * Ensure a project-local `.gemini/settings.json` exists with headless-safe defaults.
 */
export async function ensureOnboardingConfig(configDir: string): Promise<void> {
	const settingsDir = path.join(configDir, '.gemini');
	const settingsPath = path.join(settingsDir, 'settings.json');
	await fs.mkdir(settingsDir, { recursive: true });

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
			sandbox: false
		}
	};

	if (JSON.stringify(existingConfig) === JSON.stringify(nextConfig)) {
		return;
	}

	await fs.writeFile(settingsPath, JSON.stringify(nextConfig, null, 2), 'utf-8');
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

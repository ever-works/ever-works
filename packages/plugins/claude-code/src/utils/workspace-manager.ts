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

export function unslugify(slug: string): string {
	return slug
		.replace(/-+/g, ' ')
		.toLowerCase()
		.split(' ')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
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
 * Collect categories, tags, and brands directly from the item data.
 * This is the source of truth — items define what categories/tags/brands exist.
 * Each unique value gets a generated id based on its slugified name.
 */
export function collectMetadataFromItems(items: readonly ItemData[]): {
	categories: Category[];
	tags: Tag[];
	brands: Brand[];
} {
	const categoryMap = new Map<string, Category>();
	const tagMap = new Map<string, Tag>();
	const brandMap = new Map<string, Brand>();

	for (const item of items) {
		// category can be string or string[]
		const categories = Array.isArray(item.category) ? item.category : item.category ? [item.category] : [];
		for (const cat of categories) {
			const name = typeof cat === 'string' ? cat : '';
			if (!name) continue;

			const key = name.toLowerCase().trim();
			if (!categoryMap.has(key)) {
				categoryMap.set(key, { id: slugify(name) || key, name: unslugify(name) });
			}
		}

		// tags can be string[] or Tag[]
		if (Array.isArray(item.tags)) {
			for (const tag of item.tags) {
				const name = typeof tag === 'string' ? tag : tag?.name;
				if (!name) continue;
				const key = name.toLowerCase().trim();
				if (!tagMap.has(key)) {
					tagMap.set(key, { id: slugify(name) || key, name: unslugify(name) });
				}
			}
		}

		// brand can be string or Brand object
		if (item.brand) {
			const brandName = typeof item.brand === 'string' ? item.brand : item.brand.name;
			const brandLogo =
				typeof item.brand === 'string'
					? (item.brand_logo_url ?? undefined)
					: (item.brand.logo_url ?? undefined);
			if (brandName) {
				const key = brandName.toLowerCase().trim();
				if (!brandMap.has(key)) {
					brandMap.set(key, {
						id: slugify(brandName) || key,
						name: unslugify(brandName),
						logo_url: brandLogo
					});
				}
			}
		}
	}

	return {
		categories: [...categoryMap.values()],
		tags: [...tagMap.values()],
		brands: [...brandMap.values()]
	};
}

/**
 * Global flags needed for headless Claude Code execution.
 * See: https://github.com/anthropics/claude-code/issues/8938
 *
 * These are always the same values regardless of workspace, so
 * concurrent writes from parallel generations are safe (idempotent).
 *
 * Per-project flags (hasTrustDialogAccepted) are intentionally NOT
 * used here — they would require read-modify-write which races when
 * a user triggers multiple generations. The `-p` flag combined with
 * `--dangerously-skip-permissions` already bypasses the trust dialog.
 */
const HEADLESS_CONFIG: Record<string, unknown> = {
	hasCompletedOnboarding: true,
	bypassPermissionsModeAccepted: true,
	hasTrustDialogHooksAccepted: true,
	autoUpdates: false
};

/**
 * Ensure .claude.json has all flags needed for non-interactive execution.
 *
 * CLAUDE_CODE_CONFIG_DIR points to a per-user directory. Claude Code
 * reads .claude.json from there and will prompt for onboarding, bypass
 * permissions acceptance, and hooks trust unless the right flags are set.
 *
 * Only global (idempotent) flags are written — no per-project entries —
 * so concurrent generations for the same user are safe.
 *
 * @param configDir  Per-user config directory (CLAUDE_CODE_CONFIG_DIR)
 */
export async function ensureOnboardingConfig(configDir: string): Promise<void> {
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

	// Check if all flags are already set
	const dirty = Object.entries(HEADLESS_CONFIG).some(([key, value]) => config[key] !== value);

	if (!dirty) {
		return; // Already configured
	}

	Object.assign(config, HEADLESS_CONFIG);
	await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Clean up the workspace directory and remove its project entry
 * from .claude.json so stale paths don't accumulate. Never throws.
 */
export async function cleanupWorkspace(userId: string, directoryId: string): Promise<void> {
	try {
		const workspacePath = getWorkspacePath(userId, directoryId);
		await fs.rm(workspacePath, { recursive: true, force: true });
	} catch {
		// Cleanup failures are non-fatal
	}
}

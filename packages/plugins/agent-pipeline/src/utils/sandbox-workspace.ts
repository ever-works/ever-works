import { Bash } from 'just-bash';
import type {
	ItemData,
	DirectoryReference,
	GenerationRequest,
	ExistingItems,
	Category,
	Tag,
	Brand
} from '@ever-works/plugin';
import { slugify, validateRequiredItemFields, normalizeItemTags } from '@ever-works/plugin';

interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug?(message: string, ...args: unknown[]): void;
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
 * Build a file map for the sandbox from existing items and metadata.
 * Returns a Record<string, string> suitable for bash-tool or just-bash constructor.
 */
export function buildSandboxFiles(
	existing: ExistingItems,
	directory: DirectoryReference,
	request: GenerationRequest
): Record<string, string> {
	const files: Record<string, string> = {};

	// Seed existing items as {slug}.json
	const usedSlugs = new Set<string>();
	for (const item of existing.items) {
		const baseSlug = item.slug || slugify(item.name);
		const slug = deduplicateSlug(baseSlug, usedSlugs);
		usedSlugs.add(slug);
		files[`${slug}.json`] = JSON.stringify(item, null, 2);
	}

	// Seed metadata into _meta/
	files['_meta/directory.json'] = JSON.stringify(
		{ name: directory.name, description: directory.description },
		null,
		2
	);

	files['_meta/request.json'] = JSON.stringify({ prompt: request.prompt, name: request.name }, null, 2);

	if (existing.categories?.length) {
		files['_meta/categories.json'] = JSON.stringify(existing.categories, null, 2);
	}

	if (existing.tags?.length) {
		files['_meta/tags.json'] = JSON.stringify(existing.tags, null, 2);
	}

	if (existing.brands?.length) {
		files['_meta/brands.json'] = JSON.stringify(existing.brands, null, 2);
	}

	return files;
}

/**
 * Collect generated items from the sandbox by listing and reading JSON files.
 * Validates required fields and normalizes tags.
 */
export async function collectItemsFromSandbox(sandbox: Bash, logger?: Logger): Promise<ItemData[]> {
	const items: ItemData[] = [];

	// List all .json files in the root (exclude _meta/)
	const lsResult = await sandbox.exec('ls *.json 2>/dev/null || true');
	const fileNames = lsResult.stdout
		.split('\n')
		.map((f) => f.trim())
		.filter((f) => f.endsWith('.json'));

	if (fileNames.length === 0) {
		logger?.warn('No JSON files found in sandbox');
		return items;
	}

	for (const fileName of fileNames) {
		try {
			const content = await sandbox.readFile(fileName);
			const data = JSON.parse(content);

			if (!validateRequiredItemFields(data)) {
				logger?.warn(`Skipping ${fileName}: missing required fields (name, description, source_url, category)`);
				continue;
			}

			normalizeItemTags(data);
			items.push(data as ItemData);
		} catch (err) {
			logger?.warn(`Skipping ${fileName}: ${err instanceof Error ? err.message : 'invalid JSON'}`);
		}
	}

	return items;
}

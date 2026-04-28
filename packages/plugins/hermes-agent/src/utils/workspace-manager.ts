import * as fs from 'fs/promises';
import * as path from 'path';
import { jsonrepair, normalizeItemTags, validateRequiredItemFields, type ItemData } from '@ever-works/plugin';
import { BASE_TEMP_DIR, RESULT_FILE_NAME, RESULT_SCHEMA_FILE_NAME } from '../types.js';

interface Logger {
	warn(message: string, ...args: unknown[]): void;
}

export function getWorkspacePath(userId: string, directoryId: string): string {
	return path.join(BASE_TEMP_DIR, userId, directoryId);
}

export async function createWorkspace(userId: string, directoryId: string): Promise<string> {
	const workspacePath = getWorkspacePath(userId, directoryId);
	await fs.mkdir(path.join(workspacePath, '_meta'), { recursive: true });
	return workspacePath;
}

export async function seedExistingItems(workspacePath: string, items: readonly ItemData[]): Promise<void> {
	await fs.writeFile(
		path.join(workspacePath, '_meta', 'existing-items.json'),
		JSON.stringify(items, null, 2),
		'utf-8'
	);
}

export async function seedMetadata(
	workspacePath: string,
	metadata: Record<string, unknown>
): Promise<void> {
	await fs.writeFile(
		path.join(workspacePath, '_meta', 'workspace-metadata.json'),
		JSON.stringify(metadata, null, 2),
		'utf-8'
	);
}

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
	await fs.rm(workspacePath, { recursive: true, force: true });
}

export function collectMetadataFromItems(items: readonly ItemData[]): {
	categories: string[];
	tags: string[];
	brands: string[];
	collections: string[];
} {
	const categories = new Set<string>();
	const tags = new Set<string>();
	const brands = new Set<string>();

	for (const item of items) {
		if (typeof item.category === 'string' && item.category.trim()) {
			categories.add(item.category.trim());
		}

		if (Array.isArray(item.tags)) {
			for (const tag of item.tags) {
				if (typeof tag === 'string' && tag.trim()) {
					tags.add(tag.trim());
				}
			}
		}

		if (typeof item.brand === 'string' && item.brand.trim()) {
			brands.add(item.brand.trim());
		}
	}

	return {
		categories: [...categories].sort(),
		tags: [...tags].sort(),
		brands: [...brands].sort(),
		collections: []
	};
}

export function getResultFilePath(workspacePath: string): string {
	return path.join(workspacePath, '_meta', RESULT_FILE_NAME);
}

export async function writeResultSchema(workspacePath: string): Promise<void> {
	const schema = {
		type: 'object',
		additionalProperties: false,
		required: ['items'],
		properties: {
			items: {
				type: 'array',
				minItems: 1,
				items: {
					type: 'object',
					additionalProperties: true,
					required: ['name', 'description', 'source_url', 'category', 'tags'],
					properties: {
						name: { type: 'string' },
						description: { type: 'string' },
						source_url: { type: 'string' },
						category: { type: 'string' },
						tags: {
							type: 'array',
							items: { type: 'string' }
						},
						brand: { type: 'string' },
						website_url: { type: 'string' },
						image_url: { type: 'string' },
						markdown: { type: 'string' },
						pricing_json: {},
						extra: {}
					}
				}
			}
		}
	} as const;

	await fs.writeFile(
		path.join(workspacePath, '_meta', RESULT_SCHEMA_FILE_NAME),
		JSON.stringify(schema, null, 2),
		'utf-8'
	);
}

export async function readGeneratedItems(
	workspacePath: string,
	logger?: Logger
): Promise<ItemData[]> {
	let content: string;
	try {
		content = await fs.readFile(getResultFilePath(workspacePath), 'utf-8');
	} catch {
		logger?.warn(`Hermes result file not found at ${getResultFilePath(workspacePath)}`);
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		parsed = JSON.parse(jsonrepair(content));
		logger?.warn('Repaired malformed JSON in Hermes result file');
	}

	const rawItems =
		Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null | undefined)?.items;
	if (!Array.isArray(rawItems)) {
		logger?.warn('Hermes result file did not contain an items array');
		return [];
	}

	const items: ItemData[] = [];
	for (const [index, candidate] of rawItems.entries()) {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
			logger?.warn(`Skipping Hermes item at index ${index}: expected object`);
			continue;
		}

		const record = { ...(candidate as Record<string, unknown>) };
		if (!validateRequiredItemFields(record)) {
			logger?.warn(
				`Skipping Hermes item at index ${index}: missing required fields (name, description, source_url, category)`
			);
			continue;
		}

		normalizeItemTags(record);
		items.push(record as unknown as ItemData);
	}

	return items;
}

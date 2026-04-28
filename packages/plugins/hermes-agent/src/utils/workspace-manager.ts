import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { jsonrepair, normalizeItemTags, validateRequiredItemFields, type ItemData } from '@ever-works/plugin';
import { BASE_TEMP_DIR, RESULT_FILE_NAME, RESULT_SCHEMA_FILE_NAME } from '../types.js';

interface Logger {
	warn(message: string, ...args: unknown[]): void;
}

export interface GeneratedItemsReadResult {
	items: ItemData[];
	errors: string[];
	repairedJson: boolean;
	resultFilePath: string;
}

function sanitizePathSegment(value: string, fieldName: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${fieldName} is required to create a Hermes workspace`);
	}

	const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
	if (!sanitized) {
		throw new Error(`${fieldName} did not contain any path-safe characters`);
	}

	return sanitized;
}

function assertWithinBaseDir(targetPath: string): string {
	const resolvedBaseDir = path.resolve(BASE_TEMP_DIR);
	const resolvedTargetPath = path.resolve(targetPath);

	if (resolvedTargetPath !== resolvedBaseDir && !resolvedTargetPath.startsWith(`${resolvedBaseDir}${path.sep}`)) {
		throw new Error(`Resolved Hermes workspace path escaped the base temp directory: ${resolvedTargetPath}`);
	}

	return resolvedTargetPath;
}

export function getWorkspacePath(userId: string, directoryId: string): string {
	return assertWithinBaseDir(
		path.join(
			BASE_TEMP_DIR,
			sanitizePathSegment(userId, 'userId'),
			sanitizePathSegment(directoryId, 'directoryId')
		)
	);
}

export async function createWorkspace(userId: string, directoryId: string): Promise<string> {
	const workspaceRoot = getWorkspacePath(userId, directoryId);
	await fs.mkdir(workspaceRoot, { recursive: true });

	const workspacePath = assertWithinBaseDir(
		await fs.mkdtemp(path.join(workspaceRoot, `run-${randomUUID()}-`))
	);
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

export async function seedMetadata(workspacePath: string, metadata: Record<string, unknown>): Promise<void> {
	await fs.writeFile(
		path.join(workspacePath, '_meta', 'workspace-metadata.json'),
		JSON.stringify(metadata, null, 2),
		'utf-8'
	);
}

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
	await fs.rm(assertWithinBaseDir(workspacePath), { recursive: true, force: true });
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

function validateItemRecord(record: Record<string, unknown>, index: number): string[] {
	const errors: string[] = [];
	const requiredFields = ['name', 'description', 'source_url', 'category'] as const;
	const missingFields = requiredFields.filter((field) => !record[field]);

	if (missingFields.length > 0 || !validateRequiredItemFields(record)) {
		errors.push(`Item ${index} is missing required fields: ${missingFields.join(', ')}`);
	}

	if (!Array.isArray(record.tags)) {
		errors.push(`Item ${index} has invalid tags: expected an array of strings`);
	} else if (record.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
		errors.push(`Item ${index} has invalid tags: all tags must be non-empty strings`);
	}

	for (const field of [
		'name',
		'description',
		'source_url',
		'category',
		'brand',
		'website_url',
		'image_url',
		'markdown'
	]) {
		const value = record[field];
		if (value !== undefined && value !== null && typeof value !== 'string') {
			errors.push(`Item ${index} has invalid ${field}: expected a string`);
		}
	}

	return errors;
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

export async function readGeneratedResult(workspacePath: string, logger?: Logger): Promise<GeneratedItemsReadResult> {
	let content: string;
	const resultFilePath = getResultFilePath(workspacePath);
	try {
		content = await fs.readFile(resultFilePath, 'utf-8');
	} catch {
		const message = `Hermes result file not found at ${resultFilePath}`;
		logger?.warn(message);
		return {
			items: [],
			errors: [message],
			repairedJson: false,
			resultFilePath
		};
	}

	let parsed: unknown;
	let repairedJson = false;
	try {
		parsed = JSON.parse(content);
	} catch {
		parsed = JSON.parse(jsonrepair(content));
		repairedJson = true;
		logger?.warn('Repaired malformed JSON in Hermes result file');
	}

	const rawItems = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null | undefined)?.items;
	if (!Array.isArray(rawItems)) {
		const message = 'Hermes result file did not contain an items array';
		logger?.warn(message);
		return {
			items: [],
			errors: [message],
			repairedJson,
			resultFilePath
		};
	}

	const items: ItemData[] = [];
	const errors: string[] = [];
	for (const [index, candidate] of rawItems.entries()) {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
			const message = `Skipping Hermes item at index ${index}: expected object`;
			logger?.warn(message);
			errors.push(message);
			continue;
		}

		const record = { ...(candidate as Record<string, unknown>) };
		const itemErrors = validateItemRecord(record, index);
		if (itemErrors.length > 0) {
			for (const message of itemErrors) {
				logger?.warn(message);
				errors.push(message);
			}
			continue;
		}

		normalizeItemTags(record);
		items.push(record as unknown as ItemData);
	}

	return {
		items,
		errors,
		repairedJson,
		resultFilePath
	};
}

export async function readGeneratedItems(workspacePath: string, logger?: Logger): Promise<ItemData[]> {
	return (await readGeneratedResult(workspacePath, logger)).items;
}

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExistingItems } from '@ever-works/plugin';
import { slugify } from '@ever-works/plugin';
import { hashWorkspaceContent, stringifyWorkspaceItem } from '../utils/sandbox-workspace.js';

export interface WorkspaceOverview {
	totalItems: number;
	newItems: number;
	updatedItems: number;
	categories: string[];
	tags: string[];
	brands: string[];
}

type ExistingItemHashes = Map<string, string>;

export async function readWorkspaceOverview(
	workspacePath: string,
	existingItems: ExistingItems['items'] = []
): Promise<WorkspaceOverview> {
	const metaDir = join(workspacePath, '_meta');

	let itemFiles: string[] = [];
	try {
		const entries = await readdir(workspacePath);
		itemFiles = entries.filter((f) => f.endsWith('.json'));
	} catch {
		/* workspace may not exist */
	}

	const existingHashes = await readExistingItemHashes(metaDir, existingItems);
	const { newItems, updatedItems } = await countWorkspaceChanges(workspacePath, itemFiles, existingHashes);

	const [categories, tags, brands] = await Promise.all([
		readTaxonomyNames(join(metaDir, 'categories.json')),
		readTaxonomyNames(join(metaDir, 'tags.json')),
		readTaxonomyNames(join(metaDir, 'brands.json'))
	]);

	return {
		totalItems: itemFiles.length,
		newItems,
		updatedItems,
		categories,
		tags,
		brands
	};
}

async function readTaxonomyNames(filePath: string): Promise<string[]> {
	try {
		const parsed = JSON.parse(await readFile(filePath, 'utf-8'));
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((e): e is { name?: string } => typeof e === 'object' && e !== null)
			.map((e) => e.name)
			.filter((n): n is string => typeof n === 'string');
	} catch {
		return [];
	}
}

async function readExistingItemHashes(
	metaDir: string,
	existingItems: ExistingItems['items']
): Promise<ExistingItemHashes> {
	const seededHashes = await readSeededHashes(join(metaDir, 'seeded.json'));
	if (seededHashes.size > 0) {
		return seededHashes;
	}

	return buildExistingItemHashes(existingItems);
}

async function readSeededHashes(filePath: string): Promise<ExistingItemHashes> {
	try {
		const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
		return new Map(
			Object.entries(parsed).filter(
				(entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'
			)
		);
	} catch {
		return new Map();
	}
}

function buildExistingItemHashes(items: ExistingItems['items']): ExistingItemHashes {
	return new Map(
		items.map((item) => {
			const fileName = `${slugify(item.slug || item.name)}.json`;
			return [fileName, hashWorkspaceContent(stringifyWorkspaceItem(item))];
		})
	);
}

async function countWorkspaceChanges(
	workspacePath: string,
	itemFiles: string[],
	existingHashes: ExistingItemHashes
): Promise<{ newItems: number; updatedItems: number }> {
	if (itemFiles.length === 0) {
		return { newItems: 0, updatedItems: 0 };
	}

	let newItems = 0;
	let updatedItems = 0;

	const hashes = await Promise.all(
		itemFiles.map(async (fileName) => ({
			fileName,
			hash: await readWorkspaceItemHash(join(workspacePath, fileName))
		}))
	);

	for (const { fileName, hash } of hashes) {
		const existingHash = existingHashes.get(fileName);
		if (!existingHash) {
			newItems++;
			continue;
		}

		if (hash !== existingHash) {
			updatedItems++;
		}
	}

	return { newItems, updatedItems };
}

async function readWorkspaceItemHash(filePath: string): Promise<string | null> {
	try {
		return hashWorkspaceContent(await readFile(filePath, 'utf-8'));
	} catch {
		return null;
	}
}

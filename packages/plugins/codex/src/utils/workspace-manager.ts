import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'node:crypto';

import type { Brand, Category, ItemData, Tag } from '@ever-works/plugin';
import {
	collectMetadataFromItems,
	jsonrepair,
	normalizeItemTags,
	slugify,
	validateRequiredItemFields
} from '@ever-works/plugin';

import { BASE_TEMP_DIR } from '../types.js';

export { slugify, unslugify, collectMetadataFromItems } from '@ever-works/plugin';

interface Logger {
	warn(message: string, ...args: unknown[]): void;
}

const WRITE_CONCURRENCY = 64;

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

async function parallelBatch<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
	const results: T[] = [];
	for (let index = 0; index < tasks.length; index += concurrency) {
		const batch = tasks.slice(index, index + concurrency);
		results.push(...(await Promise.all(batch.map((fn) => fn()))));
	}
	return results;
}

export function getWorkspacePath(userId: string, directoryId: string): string {
	return path.join(BASE_TEMP_DIR, userId, directoryId);
}

export async function createWorkspace(userId: string, directoryId: string): Promise<string> {
	const workspacePath = getWorkspacePath(userId, directoryId);
	await fs.rm(workspacePath, { recursive: true, force: true });
	await fs.mkdir(path.join(workspacePath, '_meta'), { recursive: true });
	return workspacePath;
}

export async function seedExistingItems(workspacePath: string, items: readonly ItemData[]): Promise<void> {
	if (!items.length) {
		return;
	}

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

export async function readGeneratedItems(workspacePath: string, logger?: Logger): Promise<ItemData[]> {
	let entries: string[];
	try {
		const dirEntries = await fs.readdir(workspacePath, { withFileTypes: true });
		entries = dirEntries
			.filter((entry) => !entry.isDirectory() && entry.name.endsWith('.json'))
			.map((entry) => entry.name);
	} catch {
		logger?.warn('Could not read Codex workspace directory');
		return [];
	}

	if (entries.length === 0) {
		return [];
	}

	let seededHashes: Record<string, string> = {};
	try {
		const manifestContent = await fs.readFile(path.join(workspacePath, '_meta', 'seeded.json'), 'utf-8');
		seededHashes = JSON.parse(manifestContent) as Record<string, string>;
	} catch {
		// no seed manifest
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

				let data: unknown;
				try {
					data = JSON.parse(content);
				} catch {
					const repaired = jsonrepair(content);
					data = JSON.parse(repaired);
					logger?.warn(`Repaired malformed JSON in ${fileName}`);
				}

				if (!validateRequiredItemFields(data as Record<string, unknown>)) {
					logger?.warn(`Skipping ${fileName}: missing required fields`);
					return null;
				}

				normalizeItemTags(data as Record<string, unknown>);
				return data as ItemData;
			} catch (error) {
				logger?.warn(`Skipping ${fileName}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
				return null;
			}
		})
	);

	return results.filter((item): item is ItemData => item !== null);
}

export async function ensureOnboardingConfig(_configDir: string): Promise<void> {}

export async function cleanupWorkspace(userId: string, directoryId: string): Promise<void> {
	try {
		await fs.rm(getWorkspacePath(userId, directoryId), { recursive: true, force: true });
	} catch {
		// non-fatal
	}
}

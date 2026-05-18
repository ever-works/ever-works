import * as fs from 'fs/promises';
// POSIX path joins keep test assertions and CLI-friendly paths stable across
// platforms (Node accepts forward slashes on Windows for FS ops).
import * as path from 'path/posix';
import { createHash, randomUUID } from 'node:crypto';

import type { Brand, Category, ItemData, ReferenceEntry, Tag } from '@ever-works/plugin';
import { jsonrepair, normalizeItemTags, slugify, validateRequiredItemFields } from '@ever-works/plugin';

import { BASE_TEMP_DIR } from '../types.js';

export { slugify, unslugify, collectMetadataFromItems } from '@ever-works/plugin';

interface Logger {
	warn(message: string, ...args: unknown[]): void;
}

const WRITE_CONCURRENCY = 64;

function stripMarkdownCodeFence(content: string): string {
	const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
	return fencedMatch?.[1]?.trim() || content;
}

function extractWrappedItem(data: unknown): Record<string, unknown> | null {
	if (!data || typeof data !== 'object') {
		return null;
	}

	const record = data as Record<string, unknown>;
	if (typeof record.name === 'string' || typeof record.description === 'string') {
		return record;
	}

	for (const key of ['item', 'data', 'result']) {
		const nested = record[key];
		if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
			return nested as Record<string, unknown>;
		}
	}

	return record;
}

function findValidNestedItem(data: unknown, depth = 0): Record<string, unknown> | null {
	if (!data || typeof data !== 'object' || depth > 4) {
		return null;
	}

	const record = data as Record<string, unknown>;
	if (validateRequiredItemFields(record)) {
		return record;
	}

	for (const value of Object.values(record)) {
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			const nested = findValidNestedItem(value, depth + 1);
			if (nested) {
				return nested;
			}
		}
	}

	return null;
}

function coerceToItemRecord(data: Record<string, unknown>): Record<string, unknown> {
	if (validateRequiredItemFields(data)) {
		return data;
	}

	const nested = findValidNestedItem(data);
	if (nested) {
		return nested;
	}

	return data;
}

function parseWorkspaceItemContent(content: string): Record<string, unknown> {
	const candidates = [content, stripMarkdownCodeFence(content)];

	for (const candidate of candidates) {
		try {
			return extractWrappedItem(JSON.parse(candidate)) ?? {};
		} catch {
			// keep trying
		}

		try {
			return extractWrappedItem(JSON.parse(jsonrepair(candidate))) ?? {};
		} catch {
			// keep trying
		}
	}

	const objectMatch = stripMarkdownCodeFence(content).match(/\{[\s\S]*\}/u);
	if (objectMatch) {
		try {
			return extractWrappedItem(JSON.parse(jsonrepair(objectMatch[0]))) ?? {};
		} catch {
			// fall through
		}
	}

	throw new Error('invalid JSON');
}

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

export function getWorkspacePath(userId: string, workId: string, runId: string): string {
	return path.join(BASE_TEMP_DIR, userId, `${workId}-${runId}`);
}

export async function createWorkspace(userId: string, workId: string): Promise<string> {
	const workspacePath = getWorkspacePath(userId, workId, randomUUID());
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
		work?: { name: string; description?: string };
		request?: { prompt?: string; name?: string };
		categories?: readonly Category[];
		tags?: readonly Tag[];
		brands?: readonly Brand[];
		references?: readonly ReferenceEntry[];
	}
): Promise<void> {
	const metaDir = path.join(workspacePath, '_meta');

	if (metadata.work) {
		await fs.writeFile(path.join(metaDir, 'work.json'), JSON.stringify(metadata.work, null, 2), 'utf-8');
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
	if (metadata.references?.length) {
		const lines = metadata.references.map((reference) => JSON.stringify(reference)).join('\n');
		await fs.writeFile(path.join(metaDir, 'references.jsonl'), lines + '\n', 'utf-8');
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
		logger?.warn('Could not read Codex workspace work');
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

				const data = coerceToItemRecord(parseWorkspaceItemContent(content));

				if (!validateRequiredItemFields(data)) {
					logger?.warn(`Skipping ${fileName}: missing required fields`);
					return null;
				}

				normalizeItemTags(data);
				return data as unknown as ItemData;
			} catch (error) {
				logger?.warn(`Skipping ${fileName}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
				return null;
			}
		})
	);

	return results.filter((item): item is ItemData => item !== null);
}

export async function describeWorkspaceOutputs(workspacePath: string): Promise<string[]> {
	try {
		const dirEntries = await fs.readdir(workspacePath, { withFileTypes: true });
		return dirEntries
			.filter((entry) => !entry.name.startsWith('.'))
			.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
			.sort();
	} catch {
		return [];
	}
}

export async function writeGeneratedItems(workspacePath: string, items: readonly ItemData[]): Promise<void> {
	if (!items.length) {
		return;
	}

	const existingEntries = await fs.readdir(workspacePath, { withFileTypes: true }).catch(() => []);
	const usedSlugs = new Set(
		existingEntries
			.filter((entry) => !entry.isDirectory() && entry.name.endsWith('.json'))
			.map((entry) => entry.name.replace(/\.json$/u, ''))
	);

	const writes: (() => Promise<void>)[] = [];
	for (const item of items) {
		const baseSlug = item.slug || slugify(item.name);
		const slug = deduplicateSlug(baseSlug, usedSlugs);
		usedSlugs.add(slug);

		const normalizedItem: ItemData = {
			...item,
			slug
		};

		writes.push(() =>
			fs.writeFile(path.join(workspacePath, `${slug}.json`), JSON.stringify(normalizedItem, null, 2), 'utf-8')
		);
	}

	await parallelBatch(writes, WRITE_CONCURRENCY);
}

export async function cleanupWorkspace(workspacePath: string): Promise<void> {
	try {
		await fs.rm(workspacePath, { recursive: true, force: true });
	} catch {
		// non-fatal
	}
}

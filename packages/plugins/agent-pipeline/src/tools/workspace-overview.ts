import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkspaceOverview {
	totalItems: number;
	categories: string[];
	tags: string[];
	brands: string[];
}

export async function readWorkspaceOverview(workspacePath: string): Promise<WorkspaceOverview> {
	const metaDir = join(workspacePath, '_meta');

	let totalItems = 0;
	try {
		const entries = await readdir(workspacePath);
		totalItems = entries.filter((f) => f.endsWith('.json')).length;
	} catch {
		/* workspace may not exist */
	}

	const [categories, tags, brands] = await Promise.all([
		readTaxonomyNames(join(metaDir, 'categories.json')),
		readTaxonomyNames(join(metaDir, 'tags.json')),
		readTaxonomyNames(join(metaDir, 'brands.json'))
	]);

	return { totalItems, categories, tags, brands };
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

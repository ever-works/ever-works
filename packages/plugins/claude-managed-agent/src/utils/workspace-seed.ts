import { createHash } from 'node:crypto';

import type { ExistingItems } from '@ever-works/plugin';
import { slugify } from '@ever-works/plugin';

import type { DirectoryReference, GenerationRequest } from '@ever-works/plugin';

import type { WorkspaceSeedFile, WorkspaceSeedManifest } from '../types.js';

function deduplicateSlug(slug: string, existingSlugs: Set<string>): string {
	if (!existingSlugs.has(slug)) {
		return slug;
	}

	let index = 2;
	while (existingSlugs.has(`${slug}-${index}`)) {
		index += 1;
	}

	return `${slug}-${index}`;
}

export function buildWorkspaceSeedManifest(
	workspacePath: string,
	directory: DirectoryReference,
	request: GenerationRequest,
	existing: ExistingItems
): WorkspaceSeedManifest {
	const files: WorkspaceSeedFile[] = [];
	const usedSlugs = new Set<string>();
	const seededManifest: Record<string, string> = {};
	const indexLines: string[] = [];

	for (const item of existing.items) {
		const baseSlug = item.slug || slugify(item.name);
		const itemSlug = deduplicateSlug(baseSlug, usedSlugs);
		usedSlugs.add(itemSlug);

		const fileName = `${itemSlug}.json`;
		const content = JSON.stringify(item, null, 2);
		seededManifest[fileName] = createHash('sha256').update(content).digest('hex');
		indexLines.push(JSON.stringify({ slug: itemSlug, name: item.name, source_url: item.source_url }));
		files.push({ path: fileName, content });
	}

	files.push({
		path: '_meta/directory.json',
		content: JSON.stringify(
			{
				name: directory.name,
				description: directory.description
			},
			null,
			2
		)
	});
	files.push({
		path: '_meta/request.json',
		content: JSON.stringify(
			{
				prompt: request.prompt,
				name: request.name,
				generationMethod: request.generationMethod,
				config: request.config
			},
			null,
			2
		)
	});
	files.push({
		path: '_meta/existing-items.jsonl',
		content: indexLines.length > 0 ? `${indexLines.join('\n')}\n` : ''
	});
	files.push({
		path: '_meta/seeded.json',
		content: JSON.stringify(seededManifest, null, 2)
	});
	files.push({
		path: '_meta/categories.json',
		content: JSON.stringify(existing.categories ?? [], null, 2)
	});
	files.push({
		path: '_meta/tags.json',
		content: JSON.stringify(existing.tags ?? [], null, 2)
	});
	files.push({
		path: '_meta/collections.json',
		content: JSON.stringify(existing.collections ?? [], null, 2)
	});
	files.push({
		path: '_meta/brands.json',
		content: JSON.stringify(existing.brands ?? [], null, 2)
	});

	return {
		workspacePath,
		files
	};
}

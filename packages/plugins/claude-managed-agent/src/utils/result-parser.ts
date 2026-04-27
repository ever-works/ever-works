import type { Brand, Category, Collection, ItemData, Tag } from '@ever-works/plugin';

import type { ManagedAgentsEvent, ManagedAgentsStructuredOutput, NormalizedManagedAgentOutputs } from '../types.js';

export function extractAgentTranscript(events: ManagedAgentsEvent[]): string {
	return events
		.filter((event) => event.type === 'agent.message')
		.flatMap((event) => event.content || [])
		.filter((block) => block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text!.trim())
		.filter(Boolean)
		.join('\n\n');
}

export function parseStructuredOutput(transcript: string): ManagedAgentsStructuredOutput {
	const parsed = extractJsonObject(transcript);
	const data = JSON.parse(parsed) as Partial<ManagedAgentsStructuredOutput>;

	if (!Array.isArray(data.items)) {
		throw new Error('Claude Managed Agents response did not include an `items` array.');
	}

	return {
		items: data.items,
		categories: data.categories,
		tags: data.tags,
		collections: data.collections,
		brands: data.brands,
		operations: data.operations,
		warnings: Array.isArray(data.warnings)
			? data.warnings.filter((warning): warning is string => typeof warning === 'string')
			: []
	};
}

export function normalizeOutputs(output: ManagedAgentsStructuredOutput): NormalizedManagedAgentOutputs {
	const categoryMap = new Map<string, Category>();
	const tagMap = new Map<string, Tag>();
	const collectionMap = new Map<string, Collection>();
	const brandMap = new Map<string, Brand>();

	for (const entry of normalizeNamedEntities(output.categories)) {
		const id = slugify(entry.name);
		categoryMap.set(id, { id, name: entry.name, description: entry.description });
	}

	for (const entry of normalizeNamedEntities(output.tags)) {
		const id = slugify(entry.name);
		tagMap.set(id, { id, name: entry.name });
	}

	for (const entry of normalizeNamedEntities(output.collections)) {
		const id = slugify(entry.name);
		collectionMap.set(id, { id, name: entry.name, description: entry.description });
	}

	for (const entry of normalizeBrandEntities(output.brands)) {
		const id = slugify(entry.name);
		brandMap.set(id, { id, ...entry });
	}

	const items: ItemData[] = output.items.map((item) => {
		const categories = normalizeStringArray(item.category).filter(Boolean);
		for (const categoryName of categories) {
			const id = slugify(categoryName);
			if (!categoryMap.has(id)) {
				categoryMap.set(id, { id, name: categoryName });
			}
		}

		const tags = normalizeStringArray(item.tags).filter(Boolean);
		for (const tagName of tags) {
			const id = slugify(tagName);
			if (!tagMap.has(id)) {
				tagMap.set(id, { id, name: tagName });
			}
		}

		const collectionName = typeof item.collection === 'string' ? item.collection.trim() : '';
		if (collectionName) {
			const id = slugify(collectionName);
			if (!collectionMap.has(id)) {
				collectionMap.set(id, { id, name: collectionName });
			}
		}

		const brandName = typeof item.brand === 'string' ? item.brand.trim() : '';
		if (brandName) {
			const id = slugify(brandName);
			if (!brandMap.has(id)) {
				brandMap.set(id, {
					id,
					name: brandName,
					logo_url: item.brand_logo_url || undefined
				});
			}
		}

		return {
			name: item.name.trim(),
			description: item.description.trim(),
			source_url: item.source_url.trim(),
			category: categories.length > 0 ? categories : ['Uncategorized'],
			tags,
			collection: collectionName || undefined,
			brand: brandName || undefined,
			brand_logo_url: item.brand_logo_url || null,
			images: Array.isArray(item.images)
				? item.images.filter((image): image is string => typeof image === 'string')
				: [],
			markdown: typeof item.markdown === 'string' ? item.markdown : undefined,
			featured: item.featured === true
		};
	});

	return {
		items,
		categories: [...categoryMap.values()],
		tags: [...tagMap.values()],
		collections: [...collectionMap.values()],
		brands: [...brandMap.values()],
		extra: output.operations
			? {
					operations: output.operations
				}
			: undefined
	};
}

function extractJsonObject(value: string): string {
	const fencedMatch = value.match(/```json\s*([\s\S]*?)```/i) || value.match(/```\s*([\s\S]*?)```/i);
	if (fencedMatch?.[1]) {
		return fencedMatch[1].trim();
	}

	const firstBrace = value.indexOf('{');
	const lastBrace = value.lastIndexOf('}');
	if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
		throw new Error('Managed agent output did not contain a JSON object.');
	}

	return value.slice(firstBrace, lastBrace + 1).trim();
}

function normalizeNamedEntities(
	values:
		| ManagedAgentsStructuredOutput['categories']
		| ManagedAgentsStructuredOutput['tags']
		| ManagedAgentsStructuredOutput['collections']
): Array<{ name: string; description?: string }> {
	if (!Array.isArray(values)) {
		return [];
	}

	return values
		.map((value) => {
			if (typeof value === 'string') {
				return { name: value.trim() };
			}

			if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') {
				return {
					name: value.name.trim(),
					description:
						'description' in value && typeof value.description === 'string'
							? value.description.trim()
							: undefined
				};
			}

			return null;
		})
		.filter((value): value is { name: string; description?: string } => Boolean(value?.name));
}

function normalizeBrandEntities(
	values: ManagedAgentsStructuredOutput['brands']
): Array<{ name: string; website?: string; logo_url?: string }> {
	if (!Array.isArray(values)) {
		return [];
	}

	return values
		.map((value) => {
			if (typeof value === 'string') {
				return { name: value.trim() };
			}

			if (value && typeof value === 'object' && 'name' in value && typeof value.name === 'string') {
				return {
					name: value.name.trim(),
					website: 'website' in value && typeof value.website === 'string' ? value.website.trim() : undefined,
					logo_url:
						'logo_url' in value && typeof value.logo_url === 'string' ? value.logo_url.trim() : undefined
				};
			}

			return null;
		})
		.filter((value): value is { name: string; website?: string; logo_url?: string } => Boolean(value?.name));
}

function normalizeStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim());
	}

	if (typeof value === 'string' && value.trim()) {
		return [value.trim()];
	}

	return [];
}

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'item'
	);
}

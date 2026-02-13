import type { ItemData, Category, Tag, Brand } from '../common/index.js';

export { jsonrepair } from 'jsonrepair';

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
		.replace(/[-_]+/g, ' ')
		.trim()
		.split(' ')
		.map((word) => {
			if (!word) return '';

			const firstPart = word.charAt(0).toUpperCase();
			const rest = word.slice(1);
			const hasExistingCaps = /[A-Z]/.test(rest);

			return hasExistingCaps ? firstPart + rest : firstPart + rest.toLowerCase();
		})
		.join(' ')
		.replace(/\s?\/\s?/g, '/');
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
 * Validate that an item has all required fields: name, description, source_url, category.
 */
export function validateRequiredItemFields(data: Record<string, unknown>): boolean {
	return !!(data.name && data.description && data.source_url && data.category);
}

/**
 * Ensure the tags field is always an array.
 */
export function normalizeItemTags(data: Record<string, unknown>): void {
	if (!Array.isArray(data.tags)) {
		data.tags = [];
	}
}

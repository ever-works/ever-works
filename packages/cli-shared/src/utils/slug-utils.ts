/**
 * Generates a URL-friendly slug from a string
 */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

/**
 * Validates slug format
 */
export function validateSlug(slug: string): string | boolean {
	if (slug.length < 2) {
		return 'Slug must be at least 2 characters long';
	}
	if (slug.length > 50) {
		return 'Slug must be less than 50 characters';
	}
	const slugRegex = /^[a-z0-9-]+$/;
	if (!slugRegex.test(slug)) {
		return 'Slug can only contain lowercase letters, numbers, and hyphens';
	}
	if (slug.startsWith('-') || slug.endsWith('-')) {
		return 'Slug cannot start or end with a hyphen';
	}

	if (slug.includes('--')) {
		return 'Slug cannot contain consecutive hyphens';
	}

	return true;
}

/**
 * Generates an incremented slug for conflict resolution
 */
export function generateIncrementedSlug(baseSlug: string, increment: number): string {
	return `${baseSlug}-${increment}`;
}

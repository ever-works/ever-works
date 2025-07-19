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
export function validateSlug(slug: string): { isValid: boolean; error?: string } {
    if (slug.length < 2) {
        return { isValid: false, error: 'Slug must be at least 2 characters long' };
    }
    if (slug.length > 50) {
        return { isValid: false, error: 'Slug must be less than 50 characters' };
    }
    const slugRegex = /^[a-z0-9-]+$/;
    if (!slugRegex.test(slug)) {
        return { isValid: false, error: 'Slug can only contain lowercase letters, numbers, and hyphens' };
    }
    if (slug.startsWith('-') || slug.endsWith('-')) {
        return { isValid: false, error: 'Slug cannot start or end with a hyphen' };
    }
    if (slug.includes('--')) {
        return { isValid: false, error: 'Slug cannot contain consecutive hyphens' };
    }
    return { isValid: true };
}

/**
 * Generates an incremented slug for conflict resolution
 */
export function generateIncrementedSlug(baseSlug: string, increment: number): string {
    return `${baseSlug}-${increment}`;
}

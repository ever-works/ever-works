import { ItemData } from '@/lib/api/types-only';

export function getCategoryName(category: ItemData['category']): string {
    if (!category) {
        return '';
    }

    // Handle string array - return first category
    if (Array.isArray(category)) {
        return category[0] || '';
    }

    return category;
}

export function getCategoryNames(category: ItemData['category']): string[] {
    if (!category) {
        return [];
    }

    // Handle string array
    if (Array.isArray(category)) {
        return category;
    }

    return [category];
}

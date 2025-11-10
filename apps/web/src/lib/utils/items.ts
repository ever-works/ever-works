import { ItemData } from '@/lib/api/types-only';

export function getCategoryName(category: ItemData['category']): string {
    if (!category) {
        return '';
    }

    return typeof category === 'string' ? category : category.name || '';
}

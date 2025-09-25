import { directoryAPI } from '@/lib/api';
import type { ItemData } from '@/lib/api/types-only';
import { ItemsPageClient } from '@/components/directories/detail/items/ItemsPageClient';
import { ItemsEmptyState } from '@/components/directories/detail/items/ItemsEmptyState';

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryItemsPage({ params }: Params) {
    const { id } = await params;

    let items: ItemData[] = [];
    let error: string | null = null;

    try {
        const res = await directoryAPI.getItems(id).catch(() => ({ items: [] }));
        items = res.items || [];
    } catch (err) {
        console.error('Failed to fetch items:', err);
        error = 'Failed to load items';
    }

    if (error) {
        return (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-6">
                <p className="text-red-800 dark:text-red-200">{error}</p>
            </div>
        );
    }

    if (items.length === 0) {
        return <ItemsEmptyState directoryId={id} />;
    }

    return <ItemsPageClient items={items} directoryId={id} />;
}

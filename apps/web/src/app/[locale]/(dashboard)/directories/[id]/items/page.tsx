import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { directoryAPI } from '@/lib/api';
import type { ItemData, Category, Collection, Tag } from '@/lib/api/types-only';
import { ItemsPageClient } from '@/components/directories/detail/items/ItemsPageClient';
import { ItemsEmptyState } from '@/components/directories/detail/items/ItemsEmptyState';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('items') };
}

type Params = { params: Promise<{ id: string }> };

export default async function DirectoryItemsPage({ params }: Params) {
    const { id } = await params;

    let items: ItemData[] = [];
    let categories: Category[] = [];
    let tags: Tag[] = [];
    let collections: Collection[] = [];
    let error: string | null = null;

    try {
        // Fetch items and taxonomy data in parallel
        const [itemsRes, taxonomyRes] = await Promise.all([
            directoryAPI.getItems(id).catch(() => ({ items: [] })),
            directoryAPI
                .getCategoriesTags(id)
                .catch(() => ({ categories: [], tags: [], collections: [] })),
        ]);

        items = itemsRes.items || [];

        // Convert string arrays to Category/Tag/Collection objects if needed
        const rawCategories = taxonomyRes.categories || [];
        const rawTags = taxonomyRes.tags || [];
        const rawCollections = taxonomyRes.collections || [];

        // Ensure categories have proper structure
        categories = rawCategories.map((cat: string | Category) => {
            if (typeof cat === 'string') {
                return { id: cat, name: cat };
            }
            return cat;
        });

        // Ensure tags have proper structure
        // Use the string itself as ID (it's likely already a slug that matches item references)
        tags = rawTags.map((tag: string | Tag) => {
            if (typeof tag === 'string') {
                return { id: tag, name: tag };
            }
            return tag;
        });

        // Ensure collections have proper structure
        collections = rawCollections.map((col: string | Collection) => {
            if (typeof col === 'string') {
                return { id: col, name: col };
            }
            return col;
        });
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

    return (
        <ItemsPageClient
            items={items}
            directoryId={id}
            categories={categories}
            tags={tags}
            collections={collections}
        />
    );
}

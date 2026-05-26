import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workAPI } from '@/lib/api';
import type { SourceValidationSettingsDto } from '@/lib/api/types-only';
import { ItemsPageClient } from '@/components/works/detail/items/ItemsPageClient';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('items') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkItemsPage({ params }: Params) {
    const { id } = await params;

    // Items + taxonomy are intentionally NOT fetched on the server
    // any more — `workAPI.getItems()` and `workAPI.getCategoriesTags()`
    // both trigger a `cloneOrPull()` of the data repo on the API
    // side, which can take 10–20 s on large repos and previously
    // blocked the whole route from rendering. They now load
    // client-side from `loadItemsForList()` inside `ItemsPageClient`,
    // so the page shell (title, tabs, search input, sticky actions)
    // paints immediately and the rows fill in once the clone
    // completes.
    //
    // `getSourceValidationSettings` stays in SSR — it's a cheap DB
    // read, and the Source Health tab needs it on first paint.
    let sourceValidationSettings: SourceValidationSettingsDto | null = null;
    try {
        sourceValidationSettings = await workAPI.getSourceValidationSettings(id).catch(() => null);
    } catch (err) {
        console.error('Failed to fetch source validation settings:', err);
    }

    return <ItemsPageClient workId={id} sourceValidationSettings={sourceValidationSettings} />;
}

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { memoryAPI, EMPTY_MEMORY_RESPONSE, type MemoryResponse } from '@/lib/api/memory';
import { MemoryShell } from '@/components/memory';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.memoryPage');
    return { title: t('title') };
}

/**
 * Org-wide Memory (Cortex P1) — `/memory` catalog page.
 *
 * Server-fetches the initial aggregation once (documents + facets +
 * counts for the active Organization). The fetch is defensive
 * (`.catch`) so a flaky API / no-active-org renders the empty-state
 * surface instead of a 500 — the API itself already returns an empty
 * payload when there is no resolvable Organization, so the shell reads
 * `documents.length === 0` and shows the appropriate empty state.
 *
 * All interactivity (search, filter chips, view toggle) lives in the
 * client `MemoryShell`, which re-queries the same-origin BFF proxy
 * (`/api/memory`).
 */
export default async function MemoryPage() {
    const initial: MemoryResponse = await memoryAPI
        .get({ limit: 200 })
        .catch(() => EMPTY_MEMORY_RESPONSE);

    return <MemoryShell initial={initial} />;
}

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewPageClient, type ChipType } from '@/components/new';
import { templatesAPI } from '@/lib/api/templates';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.newPage');
    return { title: t('title') };
}

const VALID_CHIP_TYPES: ChipType[] = [
    'mission',
    'idea',
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
];

/**
 * Phase 6.5 PR CC2 — unified `/new` page (spec §8b).
 *
 * Reads an optional `?type=<chip>` query param to pre-select the
 * chip. PR Q's "+ New Mission" button on `/missions` passes
 * `type=mission`; PR DD's sidebar "+ New" repoint passes no
 * type. Unknown values are ignored — the page renders with no
 * chip preselected.
 *
 * Phase 8 PR Y — also reads an optional `?template=<id>` query
 * param. When set AND the resolved chip is `'mission'`, the
 * server fetches the Mission template's catalog row and forwards
 * its name + description so NewPageClient can pre-fill the
 * prompt. Unknown / non-mission templates are silently ignored
 * (the page renders empty just like before).
 */
type SearchParams = Promise<{ type?: string; template?: string }>;

export default async function NewPage({ searchParams }: { searchParams: SearchParams }) {
    const params = await searchParams;
    const raw = (params?.type ?? '').trim().toLowerCase();
    const initialType: ChipType | null = (VALID_CHIP_TYPES as string[]).includes(raw)
        ? (raw as ChipType)
        : null;

    let initialPrompt: string | undefined;
    let initialTemplateId: string | undefined;
    const templateIdRaw = (params?.template ?? '').trim();
    if (initialType === 'mission' && templateIdRaw.length > 0) {
        // Mission templates list is small (≤2 in v1) — a single
        // fetch on render is fine; no need to look up by id
        // separately. Defensive .catch(() => []) so a flaky API
        // surfaces the empty form instead of 500ing the page.
        const list = await templatesAPI.list('mission').catch(() => ({
            templates: [] as Array<{ id: string; name: string; description?: string | null }>,
        }));
        const tpl = list.templates.find((t) => t.id === templateIdRaw);
        if (tpl) {
            initialTemplateId = tpl.id;
            const description = (tpl.description ?? '').trim();
            initialPrompt = description.length > 0 ? `${tpl.name}\n\n${description}` : tpl.name;
        }
    }

    return (
        <NewPageClient
            initialType={initialType}
            initialPrompt={initialPrompt}
            initialTemplateId={initialTemplateId}
        />
    );
}

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewPageClient, type ChipType } from '@/components/new';
import { templatesAPI } from '@/lib/api/templates';
import { missionsAPI } from '@/lib/api/missions';

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
 * type. When `?type=` is missing, the page picks a sensible
 * default: **Mission** when the user hasn't created any yet
 * (so first-time users land on the persistent-goal kind),
 * otherwise **Idea** (the lighter weight one-shot path).
 *
 * Phase 8 PR Y — also reads an optional `?template=<id>` query
 * param. When set AND the resolved chip is `'mission'`, the
 * server fetches the Mission template's catalog row and forwards
 * its name + description so NewPageClient can pre-fill the
 * prompt.
 */
type SearchParams = Promise<{ type?: string; template?: string }>;

export default async function NewPage({ searchParams }: { searchParams: SearchParams }) {
    const params = await searchParams;
    const raw = (params?.type ?? '').trim().toLowerCase();
    const explicitType: ChipType | null = (VALID_CHIP_TYPES as string[]).includes(raw)
        ? (raw as ChipType)
        : null;

    // Default-chip selection: only ask the API for the mission
    // count when the URL didn't already nail down a chip — saves a
    // round-trip on the common `/new?type=…` paths from /missions
    // and template "Use this" buttons.
    let initialType: ChipType = 'mission';
    if (explicitType) {
        initialType = explicitType;
    } else {
        const missions = await missionsAPI.list().catch(() => []);
        initialType = missions.length > 0 ? 'idea' : 'mission';
    }

    let initialPrompt: string | undefined;
    let initialTemplateId: string | undefined;
    const templateIdRaw = (params?.template ?? '').trim();
    if (initialType === 'mission' && templateIdRaw.length > 0) {
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

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewPageClient, type ChipType } from '@/components/new';

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
 */
type SearchParams = Promise<{ type?: string }>;

export default async function NewPage({ searchParams }: { searchParams: SearchParams }) {
    const params = await searchParams;
    const raw = (params?.type ?? '').trim().toLowerCase();
    const initialType: ChipType | null = (VALID_CHIP_TYPES as string[]).includes(raw)
        ? (raw as ChipType)
        : null;
    return <NewPageClient initialType={initialType} />;
}

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { HelpManualIndex } from '@/components/help/HelpManualIndex';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('help') };
}

/**
 * Help centre (AW-25) — `/help`: the in-product manual as a full page, inside
 * the dashboard shell and behind its session check like every other dashboard
 * screen. The catalog ships with the build, so there is nothing to fetch.
 */
export default function HelpPage() {
    return <HelpManualIndex />;
}

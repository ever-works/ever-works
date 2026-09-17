import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PlaybookDetail } from '@/components/catalog/PlaybookDetail';
import { catalogAPI } from '@/lib/api/catalog';

type Params = Promise<{ slug: string }>;

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('catalog') };
}

/**
 * Capability catalogue (AW-21) — `/catalog/playbooks/[slug]`: one playbook in
 * full with this workspace's readiness for it. An unknown or malformed slug
 * is a 404; any other failure surfaces through the dashboard error boundary.
 */
export default async function PlaybookPage({ params }: { params: Params }) {
    const { slug } = await params;
    const result = await catalogAPI.getPlaybook(slug);
    if (!result.ok) {
        if (result.status === 404 || result.status === 400) notFound();
        throw new Error(result.message);
    }
    return (
        <div className="w-full max-w-5xl">
            <PlaybookDetail detail={result.data} />
        </div>
    );
}

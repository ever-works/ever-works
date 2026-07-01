import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import { IdeaDetailClient } from '@/components/ideas';

/**
 * `/ideas/[id]` — Idea detail page.
 *
 * Server-fetches a single Idea via the existing
 * `GET /me/work-proposals/:id` endpoint (`workProposalsAPI.get`). An
 * unknown / unauthorized id resolves to `null` → Next.js `notFound()`
 * so the user sees the standard 404 instead of a half-rendered page.
 *
 * This is the destination for the full-card click target on `IdeaCard`
 * (home preview, `/ideas` catalog, Mission detail). Rendering + the
 * live-build poller live in `IdeaDetailClient`; the server component
 * just resolves the initial Idea and hands it over.
 */
type Params = Promise<{ id: string; locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { id } = await params;
    const idea = await workProposalsAPI.get(id).catch(() => null);
    if (!idea) {
        const tPage = await getTranslations('dashboard.ideasPage');
        return { title: tPage('title') };
    }
    return { title: idea.title };
}

export default async function IdeaDetailPage({ params }: { params: Params }) {
    const { id } = await params;
    const idea = await workProposalsAPI.get(id).catch(() => null);
    if (!idea) {
        notFound();
    }

    return <IdeaDetailClient idea={idea} />;
}

import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { workProposalsAPI, type IdeaWorkLink } from '@/lib/api/work-proposals';
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

/**
 * Shared, request-deduped Idea fetch. `generateMetadata` and the page
 * component both need the Idea; wrapping in React's `cache` collapses
 * their two calls into a single HTTP request per render pass. The
 * `.catch(() => null)` degrades a transient failure (`get` now rethrows
 * non-404/403 errors) to the not-found path instead of erroring the route.
 */
const getIdea = cache((id: string) => workProposalsAPI.get(id).catch(() => null));

/**
 * PR-1 (Idea↔Work provenance) — the Idea's `idea_works` links for the
 * "Linked Works" panel. A failure here (transient blip or a 404 racing
 * a delete) degrades to an empty list so the panel simply doesn't
 * render instead of erroring the whole page.
 */
const getIdeaWorks = cache(
    (id: string): Promise<{ links: IdeaWorkLink[] }> =>
        workProposalsAPI.listWorks(id).catch(() => ({ links: [] })),
);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { id } = await params;
    const idea = await getIdea(id);
    if (!idea) {
        const tPage = await getTranslations('dashboard.ideasPage');
        return { title: tPage('title') };
    }
    return { title: idea.title };
}

export default async function IdeaDetailPage({ params }: { params: Params }) {
    const { id } = await params;
    const [idea, ideaWorks] = await Promise.all([getIdea(id), getIdeaWorks(id)]);
    if (!idea) {
        notFound();
    }

    return <IdeaDetailClient idea={idea} initialLinks={ideaWorks.links} />;
}

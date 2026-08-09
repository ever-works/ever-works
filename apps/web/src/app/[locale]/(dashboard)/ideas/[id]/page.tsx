import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
    workProposalsAPI,
    type IdeaWorkLink,
    type WorkProposalAttachmentRow,
} from '@/lib/api/work-proposals';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import { missionsAPI } from '@/lib/api/missions';
import { workAPI, type Work } from '@/lib/api/work';
import { IdeaDetailClient } from '@/components/ideas';
import { findMatchingWork } from '@/components/ideas/idea-work-match';

/**
 * `/ideas/[id]` — Idea detail page.
 *
 * Server-fetches a single Idea via the existing
 * `GET /me/work-proposals/:id` endpoint (`workProposalsAPI.get`). An
 * unknown / unauthorized id resolves to `null` → Next.js `notFound()`
 * so the user sees the standard 404 instead of a half-rendered page.
 *
 * Everything else on the page is a satellite of that Idea — its
 * provenance links, Agents and attachments — fetched in
 * parallel and degraded to an empty panel on failure, so one flaky
 * endpoint can never take down the whole route. Rendering, the
 * live-build poller and the mutations live in `IdeaDetailClient`.
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
 * PR-1 (Idea↔Work provenance) — the Idea's `idea_works` links, which
 * are also the authoritative record of whether the Idea was ever built.
 * A failure here (transient blip or a 404 racing a delete) degrades to
 * an empty list so the panel reads "not built yet" rather than erroring
 * the whole page.
 */
const getIdeaWorks = cache(
    (id: string): Promise<{ links: IdeaWorkLink[] }> =>
        workProposalsAPI.listWorks(id).catch(() => ({ links: [] })),
);

/**
 * Candidate Works for the title/description match that backstops
 * provenance (`idea-work-match.ts`). Searched by the Idea's title rather
 * than listing the whole catalog — the match requires the name to be
 * identical anyway, so anything the search misses could never have
 * matched. Degrades to `[]`: a missing match only costs the Built badge.
 */
const MATCH_CANDIDATE_LIMIT = 25;

const getWorkCandidates = cache(
    (title: string): Promise<Work[]> =>
        workAPI
            .getAll({ search: title, limit: MATCH_CANDIDATE_LIMIT })
            .then((r) => r.works)
            .catch(() => []),
);

const getAgents = cache(
    (id: string): Promise<Agent[]> =>
        agentsAPI
            .list({ ideaId: id, limit: 20 })
            .then((r) => r.data)
            .catch(() => []),
);

const getAttachments = cache(
    (id: string): Promise<WorkProposalAttachmentRow[]> =>
        workProposalsAPI.listAttachments(id).catch(() => []),
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
    const idea = await getIdea(id);
    if (!idea) {
        notFound();
    }

    // Satellites only — the Idea itself is already resolved above, and
    // the parent Mission lookup needs its `missionId`.
    const [ideaWorks, workCandidates, agents, attachments, mission] = await Promise.all([
        getIdeaWorks(id),
        getWorkCandidates(idea.title),
        getAgents(id),
        getAttachments(id),
        idea.missionId ? missionsAPI.get(idea.missionId).catch(() => null) : Promise.resolve(null),
    ]);

    // Reduced to the three fields the client renders — a full `Work` is a
    // large payload to serialize across the boundary for a fallback badge
    // and one list row.
    const matched = findMatchingWork(idea, workCandidates);

    return (
        <IdeaDetailClient
            idea={idea}
            initialLinks={ideaWorks.links}
            matchedWork={
                matched
                    ? { id: matched.id, name: matched.name, createdAt: matched.createdAt }
                    : null
            }
            agents={agents}
            attachments={attachments}
            missionTitle={mission?.title ?? null}
        />
    );
}

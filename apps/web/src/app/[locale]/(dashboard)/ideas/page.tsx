import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
    workProposalsAPI,
    type WorkProposal,
    type WorkProposalStatus,
} from '@/lib/api/work-proposals';
import { IdeasPageClient } from '@/components/ideas/IdeasPageClient';
import { ROUTES } from '@/lib/constants';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.ideasPage');
    return { title: t('title') };
}

const IDEA_STATUSES: WorkProposalStatus[] = [
    'pending',
    'queued',
    'building',
    'failed',
    'accepted',
    'dismissed',
];
const ACTIONABLE_STATUSES: WorkProposalStatus[] = ['pending', 'queued', 'building', 'failed'];
const PAGE_SIZE = 24;

type IdeasStatusFilter = 'actionable' | 'all' | 'done' | WorkProposalStatus;
type IdeasSearchParams = Promise<{
    status?: string | string[];
    search?: string | string[];
    offset?: string | string[];
}>;

function firstParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function normalizeStatusFilter(value?: string): IdeasStatusFilter {
    if (value === 'all' || value === 'done' || value === 'actionable') return value;
    if (IDEA_STATUSES.includes(value as WorkProposalStatus)) return value as WorkProposalStatus;
    // Default to 'all' so the catalog surfaces every Idea (incl.
    // accepted / dismissed) on first load — consistent with the home
    // Ideas preview, which also shows all statuses.
    return 'all';
}

function statusesForFilter(filter: IdeasStatusFilter): WorkProposalStatus[] {
    if (filter === 'all') return IDEA_STATUSES;
    if (filter === 'done') return ['accepted'];
    if (filter === 'actionable') return ACTIONABLE_STATUSES;
    return [filter];
}

function buildIdeasHref(input: {
    status?: IdeasStatusFilter;
    search?: string;
    offset?: number;
}): string {
    const params = new URLSearchParams();
    // 'all' is the default now, so omit it from the URL to keep the
    // canonical /ideas link clean.
    if (input.status && input.status !== 'all') params.set('status', input.status);
    if (input.search) params.set('search', input.search);
    if (input.offset && input.offset > 0) params.set('offset', String(input.offset));
    const qs = params.toString();
    return qs ? `${ROUTES.DASHBOARD_IDEAS}?${qs}` : ROUTES.DASHBOARD_IDEAS;
}

/**
 * Phase 5 PR N — `/ideas` dedicated catalog page. Server-fetches a
 * bounded page of Ideas and passes load errors through explicitly so
 * transient API failures do not masquerade as an empty catalog.
 */
export default async function IdeasPage({ searchParams }: { searchParams: IdeasSearchParams }) {
    const params = await searchParams;
    const status = normalizeStatusFilter(firstParam(params.status));
    const search = firstParam(params.search)?.trim() || undefined;
    const offset = Math.max(0, parseInt(firstParam(params.offset) ?? '0', 10) || 0);

    let allIdeas: WorkProposal[] = [];
    let loadError: string | null = null;
    try {
        allIdeas = await workProposalsAPI.list(statusesForFilter(status), {
            search,
            offset,
            limit: PAGE_SIZE + 1,
        });
    } catch (err) {
        loadError = err instanceof Error ? err.message : 'Failed to load Ideas.';
    }

    const hasNext = allIdeas.length > PAGE_SIZE;
    const pageIdeas = hasNext ? allIdeas.slice(0, PAGE_SIZE) : allIdeas;
    const prevOffset = Math.max(0, offset - PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;

    return (
        <IdeasPageClient
            initialIdeas={pageIdeas}
            loadError={loadError}
            filters={{ status, search }}
            pagination={{
                offset,
                hasPrevious: offset > 0,
                hasNext,
                previousHref: buildIdeasHref({ status, search, offset: prevOffset }),
                nextHref: buildIdeasHref({ status, search, offset: nextOffset }),
            }}
        />
    );
}

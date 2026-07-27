import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { meetingsAPI } from '@/lib/api/meetings';
import { workAPI } from '@/lib/api/work';
import { MeetingDetailClient, type MeetingWorkOption } from '@/components/meetings';

/**
 * Meetings — `/meetings/[id]` detail page. Server-fetches the meeting
 * (the single-meeting projection is the one that INCLUDES the
 * transcript body). Unknown ids, other owners' rows and fetch failures
 * all resolve to `null` — the API 404s identically for missing and
 * not-mine, deliberately leaking no existence — so the page renders the
 * standard 404 surface instead of a half-built detail view.
 *
 * The Work options are a best-effort side fetch (`.catch(() => [])`)
 * used only to name the routed Work and power the re-route picker.
 */
type Params = Promise<{ id: string; locale: string }>;

const WORK_OPTIONS_LIMIT = 100;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { id } = await params;
    const meeting = await meetingsAPI.get(id);
    if (!meeting) {
        const t = await getTranslations('dashboard.meetingsPage');
        return { title: t('title') };
    }
    return { title: meeting.title };
}

export default async function MeetingDetailPage({ params }: { params: Params }) {
    const { id } = await params;
    const meeting = await meetingsAPI.get(id);
    if (!meeting) {
        notFound();
    }

    const works: MeetingWorkOption[] = await workAPI
        .getAll({ limit: WORK_OPTIONS_LIMIT })
        .then((res) => (res?.works ?? []).map((work) => ({ id: work.id, name: work.name })))
        .catch(() => []);

    return <MeetingDetailClient meeting={meeting} works={works} />;
}

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { workAPI } from '@/lib/api/work';
import { MeetingForm, type MeetingWorkOption } from '@/components/meetings';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.meetingNew');
    return { title: t('title') };
}

const WORK_OPTIONS_LIMIT = 100;

/**
 * Meetings — `/meetings/new` capture form. The Work options are a
 * best-effort side fetch (`.catch(() => [])`): routing a meeting to a
 * Work is optional (meetings are org-wide by default), so a flaky works
 * endpoint must degrade to "no Work picker" rather than blocking
 * capture entirely.
 */
export default async function NewMeetingPage() {
    const works: MeetingWorkOption[] = await workAPI
        .getAll({ limit: WORK_OPTIONS_LIMIT })
        .then((res) => (res?.works ?? []).map((work) => ({ id: work.id, name: work.name })))
        .catch(() => []);

    return <MeetingForm works={works} />;
}

import { directoryAPI } from '@/lib/api';
import { DirectoryScheduleCard } from '@/components/directories/detail/DirectoryScheduleCard';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

type Params = { params: Promise<{ id: string }> };

export default async function DirectorySchedulePage({ params }: Params) {
    const { id } = await params;
    const pageT = await getTranslations('dashboard.directoryDetail.schedule.page');

    const [directoryRes, scheduleRes] = await Promise.all([
        directoryAPI.get(id),
        directoryAPI.getSchedule(id).catch(() => null),
    ]);

    const config = await directoryAPI.getConfig(id).catch(() => ({ config: null }));
    const hasInitialPrompt = Boolean(config?.config?.metadata?.initial_prompt);
    if (!hasInitialPrompt) {
        notFound();
    }

    const directory = directoryRes.directory;
    const schedule = scheduleRes?.schedule || null;

    return (
        <div className="space-y-6">
            <header className="rounded-2xl border border-card-border dark:border-card-border-dark bg-card dark:bg-card-dark p-6 shadow-sm space-y-2">
                <p className="text-2xl font-semibold text-text dark:text-text-dark">
                    {pageT('title')}
                </p>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-2xl">
                    {pageT('subtitle', {
                        name: directory.name ?? pageT('fallbackName'),
                    })}
                </p>
            </header>

            <DirectoryScheduleCard directoryId={directory.id} schedule={schedule} />
        </div>
    );
}

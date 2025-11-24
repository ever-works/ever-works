import { directoryAPI } from '@/lib/api';
import { DirectoryScheduleCard } from '@/components/directories/detail/DirectoryScheduleCard';
import { getTranslations } from 'next-intl/server';

type Params = { params: Promise<{ id: string }> };

const formatDate = (value?: string | null) => {
    if (!value) return 'Not scheduled';
    try {
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        }).format(new Date(value));
    } catch {
        return 'Not scheduled';
    }
};

export default async function DirectorySchedulePage({ params }: Params) {
    const { id } = await params;
    const t = await getTranslations('dashboard.directoryDetail.schedule.page');

    const [directoryRes, scheduleRes] = await Promise.all([
        directoryAPI.get(id),
        directoryAPI.getSchedule(id).catch(() => null),
    ]);

    const directory = directoryRes.directory;
    const schedule = scheduleRes?.schedule || null;

    const statusLabel = schedule?.status ?? 'disabled';
    const nextRunLabel = formatDate(schedule?.nextRunAt);

    return (
        <div className="space-y-6">
            <div className="rounded-lg border border-card-border dark:border-card-border-dark bg-card dark:bg-card-dark p-6 shadow-sm">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                        <div>
                            <p className="text-lg font-semibold">{t('title')}</p>
                            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                {t('subtitle', { name: directory.name ?? t('fallbackName') })}
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                            <span className="rounded-full bg-muted dark:bg-muted-dark px-3 py-1 font-medium capitalize">
                                {t('statusLabel', { status: statusLabel })}
                            </span>
                            <span className="rounded-full bg-muted dark:bg-muted-dark px-3 py-1 font-medium">
                                {t('nextRunLabel', { next: nextRunLabel })}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <DirectoryScheduleCard directoryId={directory.id} schedule={schedule} />
        </div>
    );
}

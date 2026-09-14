'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';

/** The Task the Agent is working on right now, as the page resolved it server-side. */
export interface ComputerWorkingBrief {
    taskId: string;
    taskTitle: string;
    missionTitle: string | null;
}

/**
 * The working-brief overlay: `BRIEF · <Task>` and its Mission, linking to the
 * Task — or, with nothing in flight, "Idle — no task in flight", so the
 * absence of work is itself legible rather than an overlay that vanished.
 */
export function ComputerBriefOverlay({ brief }: { brief: ComputerWorkingBrief | null }) {
    const t = useTranslations('dashboard.computer');
    return (
        <div
            data-testid="computer-brief"
            className="absolute bottom-2 left-3 max-w-[70%] rounded-md border border-white/10 bg-black/55 px-3 py-1.5 text-xs text-white shadow"
        >
            {brief ? (
                <>
                    <Link
                        href={ROUTES.DASHBOARD_TASK(brief.taskId)}
                        className="block truncate font-medium hover:underline"
                    >
                        {t('briefLabel', { task: brief.taskTitle })}
                    </Link>
                    {brief.missionTitle ? (
                        <span className="block truncate text-white/75">
                            {t('briefMission', { mission: brief.missionTitle })}
                        </span>
                    ) : null}
                </>
            ) : (
                <span>{t('briefIdle')}</span>
            )}
        </div>
    );
}

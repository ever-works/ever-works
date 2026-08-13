'use client';

import { useTranslations } from 'next-intl';
import { ShinyText } from '@/components/ui/ShinyText';

const SKELETON_LINES = ['100%', '94%', '82%', '58%'] as const;

export function MeetingSummaryGenerating() {
    const t = useTranslations('dashboard.meetingDetail');

    return (
        <div
            // `status` + polite: the summary arriving is worth announcing,
            // but never worth interrupting whatever the reader is doing.
            role="status"
            aria-live="polite"
            data-testid="meeting-summary-generating"
            className="ms-summary-generating space-y-4"
        >
            <div className="min-w-0">
                <ShinyText
                    text={t('summary.generating')}
                    className="block text-sm font-medium"
                    duration={2}
                    stagger={0.04}
                />
                <p className="mt-1 text-[11px] text-text-muted dark:text-text-muted-dark">
                    {t('summary.generatingHint')}
                </p>
            </div>

            {/* Decorative: the label above already carries the state for
                assistive tech, so the stand-in prose is hidden from it. */}
            <div className="space-y-2.5" aria-hidden>
                {SKELETON_LINES.map((width, i) => (
                    <div
                        key={width}
                        className="ms-summary-line h-2.5"
                        style={{ width, animationDelay: `${i * 0.18}s` }}
                    >
                        <span className="gp-shimmer" style={{ animationDelay: `${i * 0.18}s` }} />
                    </div>
                ))}
            </div>
        </div>
    );
}

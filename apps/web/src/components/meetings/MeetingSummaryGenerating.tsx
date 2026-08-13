'use client';

import { useTranslations } from 'next-intl';
import { ShinyText } from '@/components/ui/ShinyText';

/**
 * Meeting detail — the "the summary is being written" state of the
 * `/meetings/:id` Summary card.
 *
 * Attaching a transcript is a single opaque round trip: the API stores the
 * text, then runs the best-effort fan-out (AI summary → Memory observation →
 * activity envelope) and answers once. There is no percentage to report and
 * no stage to poll, so nothing here pretends otherwise — the panel says
 * "still working" with a shimmering stand-in for the paragraph that is
 * coming, and an indeterminate bar.
 *
 * The skeleton lines sit exactly where the summary paragraph will land, at
 * the same rhythm, so the finished text resolves into the shape the reader
 * has already been looking at rather than displacing it.
 *
 * Motion lives in CSS (`ms-summary-*` in `globals.css`) — no JS timers after
 * mount, and the whole panel goes still under `prefers-reduced-motion`.
 */

/**
 * Widths of the stand-in lines, in the ragged pattern a short paragraph
 * actually makes — an even stack of equal bars reads as a table, not prose.
 */
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

            <div
                className="relative h-0.75 overflow-hidden rounded-full"
                style={{ background: 'var(--gp-bar-track)' }}
                aria-hidden
            >
                <div
                    className="ms-summary-slide absolute inset-y-0 left-0 w-1/3 rounded-full"
                    style={{ background: 'var(--gp-bar-fill)' }}
                />
            </div>
        </div>
    );
}

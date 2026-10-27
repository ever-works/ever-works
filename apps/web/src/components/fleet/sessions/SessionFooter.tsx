'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetSessionPresence, FleetSessionRecordingState } from '@ever-works/contracts';
import { roleSentence } from './sessions.shared';

/** `12 B` · `3.4 KB` · `1.2 MB`. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Sessions on computers (FL-04 P1b, spec §5.4) — the session page's footer:
 * the role sentence ("You are driving" / "Watching · someone else is
 * driving" / "Nobody is driving"), how many other people are here, the
 * terminal size, the recording state (P3 adds the toggle) and the bandwidth
 * this tab is receiving. A live region, so a role change is announced.
 */
export function SessionFooter({
    presence,
    viewerUserId,
    role,
    size,
    recordingState,
    bytesPerSecond,
    isolatedAgentName,
    nodeName,
    recordingSlot,
}: {
    presence: FleetSessionPresence | undefined;
    viewerUserId: string | null;
    role: 'viewer' | 'driver' | null;
    size: { cols: number; rows: number } | null;
    recordingState: FleetSessionRecordingState;
    bytesPerSecond: number;
    isolatedAgentName?: string | null;
    nodeName: string;
    recordingSlot?: ReactNode;
}) {
    const t = useTranslations('fleet.sessions');
    const sentence = roleSentence(presence, { userId: viewerUserId ?? '', role });
    const others = (presence?.attached ?? []).filter(
        (entry) => entry.userId !== viewerUserId,
    ).length;

    return (
        <footer
            className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border dark:border-border-dark px-3 py-2 text-xs text-text-muted dark:text-text-muted-dark"
            data-testid="fleet-session-footer"
        >
            <span
                role="status"
                aria-live="polite"
                className="font-medium text-text dark:text-text-dark"
                data-testid="fleet-session-role"
            >
                {sentence.key === 'driving'
                    ? t('detail.driving')
                    : sentence.key === 'watchingDriven'
                      ? t('detail.watchingDriven', { others: sentence.others })
                      : role === 'viewer'
                        ? `${t('detail.watching')} · ${t('detail.nobodyDriving')}`
                        : t('detail.nobodyDriving')}
            </span>
            <span data-testid="fleet-session-watchers">
                {t('detail.watchers', { count: others })}
            </span>
            {size && (
                <span className="tabular-nums">
                    {t('detail.size', { cols: size.cols, rows: size.rows })}
                </span>
            )}
            {isolatedAgentName && (
                <span>{t('detail.isolated', { agent: isolatedAgentName, node: nodeName })}</span>
            )}
            {recordingSlot ?? (recordingState === 'recording' ? <span>●</span> : null)}
            <span className="ml-auto tabular-nums" data-testid="fleet-session-bandwidth">
                {t('detail.bandwidth', { rate: formatBytes(bytesPerSecond) })}
            </span>
        </footer>
    );
}

'use client';

import { useTranslations } from 'next-intl';

/**
 * The always-on identity watermark over a live view, so a screenshot of the
 * page names the Agent and the computer it shows.
 */
export function ComputerWatermark({
    agentName,
    nodeName,
}: {
    agentName: string;
    nodeName: string;
}) {
    const t = useTranslations('dashboard.computer');
    return (
        <div
            data-testid="computer-watermark"
            className="pointer-events-none absolute bottom-2 right-3 select-none rounded bg-black/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-white/80"
        >
            {t('watermark', { agent: agentName, node: nodeName })}
        </div>
    );
}

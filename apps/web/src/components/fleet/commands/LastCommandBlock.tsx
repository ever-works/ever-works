'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { FleetCommandLastRunResponse } from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import type { FleetOverviewBlockProps } from '../registry';
import { commandsClient } from './commands.client';
import { commandCardEnd } from './commands.shared';

function agoLabel(iso: string | null, now: number): string {
    if (!iso) return '';
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return '';
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 90) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
}

/**
 * Commands on computers (FL-12 P2, spec §5.3) — "Last command: `uptime` · ✓ ·
 * 3 min ago" on a computer's Overview: the latest run of the viewer's own
 * Commands there (each person sees only the Commands they ran, spec §8b), with
 * a link to the hub's Commands tab for this computer. Renders nothing until
 * there is one, or when the viewer may not run commands here.
 */
export default function LastCommandBlock({ nodes }: FleetOverviewBlockProps) {
    const t = useTranslations('fleet.commands.last');
    const tCard = useTranslations('fleet.commands.card');
    const node = nodes[0];
    const [last, setLast] = useState<FleetCommandLastRunResponse['last'] | undefined>(undefined);
    const [now] = useState(() => Date.now());

    const nodeId = node?.id ?? null;
    useEffect(() => {
        if (!nodeId) return;
        let cancelled = false;
        void commandsClient.lastForNode(nodeId).then((result) => {
            if (!cancelled) setLast(result.ok ? result.data.last : null);
        });
        return () => {
            cancelled = true;
        };
    }, [nodeId]);

    if (!node || !last) return null;
    const end = commandCardEnd(last.run);
    return (
        <section
            className="flex flex-wrap items-baseline gap-2 rounded-lg border border-border px-3 py-2 text-sm dark:border-border-dark"
            data-testid="fleet-last-command"
        >
            <span className="text-text-muted dark:text-text-muted-dark">{t('label')}</span>
            <code className="max-w-[24rem] truncate font-mono text-text dark:text-text-dark" title={last.command}>
                {last.command}
            </code>
            <span>·</span>
            <span>{tCard(end.key, end.values)}</span>
            <span>·</span>
            <span className="text-text-muted dark:text-text-muted-dark">
                {t('ago', { time: agoLabel(last.run.endedAt ?? last.run.startedAt, now) })}
            </span>
            <Link
                href={`${ROUTES.DASHBOARD_FLEET_COMMANDS}?node=${encodeURIComponent(node.id)}`}
                className="ml-auto text-xs text-primary hover:underline"
            >
                {t('open')}
            </Link>
        </section>
    );
}

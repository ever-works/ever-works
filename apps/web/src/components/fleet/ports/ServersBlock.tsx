'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import type { FleetPortsListResponse } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { FleetOverviewBlockProps } from '../registry';
import { portsClient, portsGroups } from './ports.shared';

/** The Overview re-reads its Servers block this often (the Ports tab itself is live at 5 s). */
const SERVERS_REFRESH_MS = 30_000;

/** At most this many web servers are named on the Overview (spec FR-7). */
const SERVERS_SHOWN = 3;

/**
 * Servers and ports (FL-10, spec §5.6, S8, FR-7) — the computer Overview's
 * **Servers** block:
 *
 * `Servers   localhost:3000 "Acme — Checkout" 200  ·  5173 "Vite App" 200  ·  3 other ports  →`
 *
 * Up to three web servers and the count of the others, each opening the Ports
 * tab with that row selected. A computer that cannot list its ports (no
 * `--manage`, offline, the kill switch) shows no block: the Ports tab is where
 * those states are explained.
 */
export default function ServersBlock({ nodes }: FleetOverviewBlockProps) {
    const t = useTranslations('fleet.ports.servers');
    const node = nodes.length === 1 ? nodes[0] : null;
    const [list, setList] = useState<FleetPortsListResponse | null>(null);

    useEffect(() => {
        if (!node) return;
        let cancelled = false;
        const read = async () => {
            const result = await portsClient.list(node.id, []);
            if (!cancelled && result.ok) setList(result.data);
        };
        void read();
        const timer = setInterval(() => void read(), SERVERS_REFRESH_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [node]);

    if (!node || !list) return null;
    const groups = portsGroups(list);
    const web = groups.web.filter((port) => !port.stopped);
    if (web.length === 0 && groups.other.length === 0) return null;
    const portsTab = ROUTES.DASHBOARD_FLEET_COMPUTER(node.id, 'ports');

    return (
        <section
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-4 py-3 text-sm dark:border-border-dark"
            data-testid="fleet-servers-block"
        >
            <h3 className="font-semibold">{t('title')}</h3>
            {web.slice(0, SERVERS_SHOWN).map((port, index) => (
                <span key={port.port} className="flex items-center gap-1">
                    {index > 0 && <span aria-hidden>·</span>}
                    <Link href={`${portsTab}&port=${port.port}`} className="hover:underline">
                        {index === 0 ? `localhost:${port.port}` : port.port}
                        {port.web?.title ? ` "${port.web.title}"` : ''} {port.web?.status}
                    </Link>
                </span>
            ))}
            {groups.other.length > 0 && (
                <span className="text-text-muted dark:text-text-muted-dark">
                    {web.length > 0 ? '· ' : ''}
                    {t('otherPorts', { count: groups.other.length })}
                </span>
            )}
            <Link href={portsTab} className="ml-auto" aria-label={t('open')}>
                <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
        </section>
    );
}

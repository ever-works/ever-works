'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ExternalLink } from 'lucide-react';
import type { FleetListeningPort, FleetPortTunnelView } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { useNow } from '../health/use-now';
import { formatBytes, portsClient, timeLeft } from './ports.shared';

/**
 * Servers and ports, phase 2 (FL-10, spec §5.4, S9, S10, U11, FR-29) — a web
 * server's **Preview in my browser**, and its state once a preview is open:
 *
 * `previewing · 58:40 left · 3 requests · 1.2 MB  [Close preview] [Copy link]`
 *
 * Opening asks the platform for the tunnel and a one-time address, and sends a
 * new tab there (opened first, blank, so the browser does not block it as a
 * pop-up). "Copy link" copies the tunnel's own address, which opens only in a
 * browser the person already opened it in (its cookie) — never the one-time
 * address. A fifth preview answers with the four open ones listed (U11).
 */
export function TunnelRowState({
    nodeId,
    port,
    tunnel,
    onChange,
}: {
    nodeId: string;
    port: FleetListeningPort;
    tunnel: FleetPortTunnelView | null;
    onChange: () => void;
}) {
    const t = useTranslations('fleet.ports.tunnel');
    const nowMs = useNow(1_000);
    const [busy, setBusy] = useState(false);

    const open = async () => {
        // Open the tab now, inside the click, then point it at the address once it is known.
        const tab = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null;
        if (tab) tab.opener = null;
        setBusy(true);
        try {
            const result = tunnel
                ? await portsClient.readPreview(nodeId, port.port)
                : await portsClient.openPreview(nodeId, port.port);
            if (!result.ok) {
                tab?.close();
                if (result.error.code === 'limit_exceeded') {
                    const listed = Array.isArray(result.error.details?.tunnels)
                        ? (result.error.details.tunnels as FleetPortTunnelView[])
                        : [];
                    toast.error(t('limit'), {
                        description: listed
                            .map((entry) => t('limitRow', { port: entry.port, left: timeLeft(entry.endsAt, Date.now()) }))
                            .join(' · '),
                    });
                } else {
                    toast.error(result.error.hint ?? t('failed'));
                }
                return;
            }
            const target = result.data.openUrl ?? result.data.tunnel.url;
            if (tab) tab.location.href = target;
            else window.open(target, '_blank', 'noopener,noreferrer');
            onChange();
        } finally {
            setBusy(false);
        }
    };

    const close = async () => {
        setBusy(true);
        try {
            const result = await portsClient.closePreview(nodeId, port.port);
            if (!result.ok) toast.error(result.error.hint ?? t('failed'));
            onChange();
        } finally {
            setBusy(false);
        }
    };

    const copy = async () => {
        if (!tunnel) return;
        try {
            await navigator.clipboard.writeText(tunnel.url);
            toast.success(t('copied'));
        } catch {
            toast.error(tunnel.url);
        }
    };

    if (!tunnel) {
        return (
            <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void open()}
                data-testid={`fleet-port-preview-${port.port}`}
            >
                <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden />
                {t('button')}
            </Button>
        );
    }

    return (
        <span className="flex flex-wrap items-center gap-2 text-xs" data-testid={`fleet-port-previewing-${port.port}`}>
            <span className="font-medium text-info">{t('previewing')}</span>
            <span>{t('timeLeft', { time: timeLeft(tunnel.endsAt, nowMs) })}</span>
            <span>{t('requests', { count: tunnel.requestCount })}</span>
            <span>{formatBytes(tunnel.bytesIn + tunnel.bytesOut)}</span>
            {tunnel.requestedBy?.startsWith('agent:') && <span>{t('openedByAgent')}</span>}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void open()}>
                <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden />
                {t('reopen')}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void close()}>
                {t('close')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void copy()}>
                {t('copyLink')}
            </Button>
        </span>
    );
}

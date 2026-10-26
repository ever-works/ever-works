'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Monitor, RefreshCw, X } from 'lucide-react';
import {
    COMPUTER_QUALITIES,
    COMPUTER_STALL_AFTER_MS,
    COMPUTER_DEAD_AFTER_MS,
    fleetDesktopWatermark,
    type ComputerQuality,
    type FleetDesktopAvailabilityView,
    type FleetDisplayView,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import type { FleetComputerTabProps } from '../registry';
import { formatFileBytes } from '../files/files.shared';
import { DesktopDisplayPicker } from './DesktopDisplayPicker';
import { DesktopHelperNote } from './DesktopHelperNote';
import { DesktopUnavailableCard } from './DesktopUnavailableCard';
import { DesktopPainter } from './desktop-painter';
import { FleetDesktopSocket } from './desktop-socket';
import {
    desktopClient,
    displayPosition,
    readRememberedDisplay,
    rememberDisplay,
    type DesktopBrowserGrant,
} from './desktop.shared';

/**
 * Desktop view & control (FL-07, spec §5.1, §5.4, §5.5, FR-1, FR-25 … FR-29) —
 * the computer page's Desktop tab: the machine's whole desktop on one display,
 * watched read-only.
 *
 * ```
 * build-01 · Desktop · Display 1 of 2 · Smooth                               ● LIVE
 * ⚠ Reduced trust — the screen helper on build-01 is hash-pinned, not signed.
 * ( live picture )                         EVER WORKS · LIVE VIEW · DESKTOP · build-01
 * Watching — nothing on build-01 is paused.             This view spends no credits.
 * [ Display 1 ▾ ] [ Smooth ▾ ] [ ↻ ] [ End view ]                Bandwidth used: 3.1 MB
 * ```
 *
 * Watching starts on an explicit click (it is audited on the platform and the
 * machine's screen is shown to whoever opens it), never on page load. When the
 * desktop cannot be shown, the ONE reason and its fix (`DesktopUnavailableCard`).
 * Control (take-over), recordings and the split beside a terminal arrive with
 * the next phase of this epic.
 */

type Phase = 'checking' | 'unavailable' | 'ready' | 'opening' | 'connecting' | 'live' | 'stalled' | 'ended';

const QUALITY_KEY = 'ew:fleet:desktop:quality';

function readQuality(): ComputerQuality {
    try {
        const stored = globalThis.localStorage?.getItem(QUALITY_KEY);
        return stored === 'sharp' || stored === 'smooth' || stored === 'steady' ? stored : 'smooth';
    } catch {
        return 'smooth';
    }
}

export default function DesktopTab({ node }: FleetComputerTabProps) {
    const t = useTranslations('fleet.desktop');
    const [availability, setAvailability] = useState<FleetDesktopAvailabilityView | null>(null);
    const [phase, setPhase] = useState<Phase>('checking');
    const [errorHint, setErrorHint] = useState<string | null>(null);
    const [viewId, setViewId] = useState<string | null>(null);
    const [displays, setDisplays] = useState<FleetDisplayView[]>([]);
    const [displayId, setDisplayId] = useState<string | null>(null);
    const [quality, setQuality] = useState<ComputerQuality>('smooth');
    const [notice, setNotice] = useState<string | null>(null);
    const [bytes, setBytes] = useState(0);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const socketRef = useRef<FleetDesktopSocket | null>(null);
    const painterRef = useRef<DesktopPainter | null>(null);
    const lastPaintRef = useRef<number>(0);
    const leavingRef = useRef(false);

    const load = useCallback(async () => {
        const result = await desktopClient.availability(node.id);
        if (!result.ok) {
            setErrorHint(result.error.hint);
            setPhase('unavailable');
            return;
        }
        setAvailability(result.data);
        setDisplays(result.data.displays);
        setPhase((current) =>
            current === 'checking' || current === 'unavailable' || current === 'ready'
                ? result.data.available
                    ? 'ready'
                    : 'unavailable'
                : current,
        );
    }, [node.id]);

    useEffect(() => {
        setQuality(readQuality());
        void load();
    }, [load]);

    // While it cannot be shown, look again every 15 s (a helper approved, a sign-in).
    useEffect(() => {
        if (phase !== 'unavailable') return;
        const timer = setInterval(() => void load(), 15_000);
        return () => clearInterval(timer);
    }, [phase, load]);

    const closeSocket = useCallback(() => {
        leavingRef.current = true;
        socketRef.current?.close();
        socketRef.current = null;
        painterRef.current?.dispose();
        painterRef.current = null;
    }, []);

    const attachTo = useCallback(
        (grant: DesktopBrowserGrant) => {
            closeSocket();
            leavingRef.current = false;
            const painter = new DesktopPainter({
                canvas: () => canvasRef.current,
                requestKeyframe: () => socketRef.current?.refresh(),
                painted: () => {
                    lastPaintRef.current = Date.now();
                    setPhase((current) => (current === 'connecting' || current === 'stalled' ? 'live' : current));
                },
            });
            painterRef.current = painter;
            const socket = new FleetDesktopSocket(grant.wsUrl, grant.token, {
                onStarted: (started) => {
                    if (started.displays.length > 0) setDisplays(started.displays);
                    if (started.display) setDisplayId(started.display.id);
                    if (started.fellBack && started.display) {
                        setNotice(t('displays.fellBack', { current: started.display.name }));
                        rememberDisplay(node.id, null);
                    }
                },
                onKeyframe: (picture) => void painter.keyframe(picture),
                onTiles: (tiles) => void painter.tiles(tiles),
                onStats: () => setBytes(socketRef.current?.bytesIn ?? 0),
                onDisplays: (next, fallback) => {
                    if (next.length > 0) setDisplays(next);
                    if (fallback) {
                        setDisplayId(fallback.id);
                        setNotice(t('displays.fellBack', { current: fallback.name }));
                        rememberDisplay(node.id, null);
                    }
                },
                onRefused: (hint) => setErrorHint(hint || null),
                onClosed: (close) => {
                    if (socketRef.current !== socket) return;
                    socketRef.current = null;
                    if (leavingRef.current) return;
                    setErrorHint(close.hint);
                    setPhase('ended');
                },
            });
            socketRef.current = socket;
            lastPaintRef.current = Date.now();
            setPhase('connecting');
            socket.open();
        },
        [closeSocket, node.id, t],
    );

    const watch = useCallback(async () => {
        setErrorHint(null);
        setNotice(null);
        setPhase('opening');
        const remembered = readRememberedDisplay(node.id);
        const result = await desktopClient.open(node.id, {
            ...(remembered ? { displayId: remembered } : {}),
            quality,
        });
        if (!result.ok) {
            setErrorHint(result.error.hint);
            setPhase('ready');
            void load();
            return;
        }
        setViewId(result.data.view.viewId);
        setDisplayId(result.data.display?.id ?? null);
        if (result.data.fellBack && remembered) {
            rememberDisplay(node.id, null);
            setNotice(t('displays.fellBack', { current: result.data.display?.name ?? '' }));
        }
        attachTo(result.data.attach);
    }, [attachTo, load, node.id, quality, t]);

    const reconnect = useCallback(async () => {
        if (!viewId) return watch();
        const result = await desktopClient.reattach(node.id, viewId);
        if (!result.ok) {
            // The view ended on the platform (another replica, the ceiling): open a fresh one.
            return watch();
        }
        attachTo(result.data);
    }, [attachTo, node.id, viewId, watch]);

    const switchDisplay = useCallback(
        async (next: string) => {
            if (!viewId || next === displayId) return;
            const result = await desktopClient.update(node.id, viewId, { displayId: next });
            if (!result.ok) {
                setErrorHint(result.error.hint);
                return;
            }
            rememberDisplay(node.id, next);
            setNotice(null);
            setDisplayId(result.data.display?.id ?? next);
            attachTo(result.data.attach);
        },
        [attachTo, displayId, node.id, viewId],
    );

    const changeQuality = (next: ComputerQuality) => {
        setQuality(next);
        try {
            globalThis.localStorage?.setItem(QUALITY_KEY, next);
        } catch {
            // not remembered
        }
        socketRef.current?.quality(next);
    };

    const end = useCallback(() => {
        closeSocket();
        if (viewId) void desktopClient.end(node.id, viewId);
        setViewId(null);
        setPhase('ready');
        void load();
    }, [closeSocket, load, node.id, viewId]);

    // Stalled at 6 s without a picture, ended at 45 s (AW-11's thresholds, spec U12).
    useEffect(() => {
        if (phase !== 'live' && phase !== 'stalled' && phase !== 'connecting') return;
        const timer = setInterval(() => {
            const silent = Date.now() - lastPaintRef.current;
            if (silent >= COMPUTER_DEAD_AFTER_MS) {
                closeSocket();
                setPhase('ended');
            } else if (silent >= COMPUTER_STALL_AFTER_MS && phase === 'live') {
                setPhase('stalled');
            }
        }, 1_000);
        return () => clearInterval(timer);
    }, [phase, closeSocket]);

    // Leaving the page ends the view.
    useEffect(
        () => () => {
            leavingRef.current = true;
            socketRef.current?.close();
            painterRef.current?.dispose();
        },
        [],
    );

    const name = node.name;
    const trust = availability?.helper?.trust ?? node.helperTrust ?? 'none';

    if (phase === 'checking') {
        return <p className="p-6 text-sm text-muted-foreground">{t('checking', { name })}</p>;
    }
    if (phase === 'unavailable' && availability?.blocker) {
        return (
            <DesktopUnavailableCard
                nodeName={name}
                blocker={availability.blocker}
                hint={availability.hint}
                lastSeen={availability.lastSeenAt}
                browserSourceAvailable={availability.browserSourceAvailable}
                onRetry={() => void load()}
            />
        );
    }
    if (phase === 'unavailable') {
        return <p className="p-6 text-sm text-destructive">{errorHint ?? t('errors.generic')}</p>;
    }

    const watching = phase === 'connecting' || phase === 'live' || phase === 'stalled' || phase === 'ended';
    const position = displayPosition(displays, displayId);

    return (
        <section className="flex flex-col gap-3" data-testid="desktop-tab">
            <header className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                    {t('strip', {
                        name,
                        index: position.index,
                        count: position.count,
                        quality: t(`quality.${quality}`),
                    })}
                </span>
                {phase === 'live' ? (
                    <span className="font-semibold text-red-600" data-testid="desktop-live">
                        ● {t('live')}
                    </span>
                ) : null}
            </header>
            <DesktopHelperNote nodeName={name} trust={trust} helper={availability?.helper ?? null} />
            {notice ? (
                <p className="text-sm text-amber-700" role="status">
                    {notice}
                </p>
            ) : null}
            {errorHint ? (
                <p className="text-sm text-destructive" role="alert">
                    {errorHint}
                </p>
            ) : null}

            {!watching ? (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-border p-8 text-center">
                    <Monitor className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                    <p className="max-w-lg text-sm text-muted-foreground">{t('watchHint', { name })}</p>
                    <Button type="button" onClick={() => void watch()} disabled={phase === 'opening'} data-testid="desktop-watch">
                        {phase === 'opening' ? t('opening') : t('watch')}
                    </Button>
                </div>
            ) : (
                <div
                    className="relative overflow-hidden rounded-lg border border-border bg-black"
                    role="region"
                    tabIndex={0}
                    aria-label={t('stage.label', { name })}
                    data-testid="desktop-stage"
                >
                    <canvas
                        ref={canvasRef}
                        className={`mx-auto block h-auto max-w-full ${phase === 'stalled' ? 'opacity-50' : ''}`}
                    />
                    <span className="pointer-events-none absolute bottom-2 right-3 text-[10px] font-semibold uppercase tracking-wide text-white/70">
                        {fleetDesktopWatermark(name)}
                    </span>
                    {phase === 'connecting' ? (
                        <p className="absolute inset-0 flex items-center justify-center text-sm text-white/80" role="status">
                            {t('connecting', { name })}
                        </p>
                    ) : null}
                    {phase === 'stalled' ? (
                        <p className="absolute inset-x-0 top-3 text-center text-sm text-white" role="status">
                            {t('stalled')}
                        </p>
                    ) : null}
                    {phase === 'ended' ? (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-white" role="status">
                            <p className="text-sm">{t('ended')}</p>
                            <Button type="button" variant="secondary" onClick={() => void reconnect()}>
                                {t('reconnect')}
                            </Button>
                        </div>
                    ) : null}
                </div>
            )}

            {watching ? (
                <footer className="flex flex-col gap-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                        <span data-testid="desktop-status">{t('status.watching', { name })}</span>
                        <span>{t('noCredits')}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <DesktopDisplayPicker
                            nodeName={name}
                            displays={displays}
                            value={displayId}
                            disabled={phase === 'ended'}
                            onChange={(next) => void switchDisplay(next)}
                        />
                        <label className="flex items-center gap-2">
                            <span className="sr-only">{t('quality.label')}</span>
                            <select
                                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                                value={quality}
                                onChange={(event) => changeQuality(event.target.value as ComputerQuality)}
                                data-testid="desktop-quality"
                            >
                                {COMPUTER_QUALITIES.map((option) => (
                                    <option key={option} value={option}>
                                        {t(`quality.${option}`)}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => socketRef.current?.refresh()}
                            aria-label={t('refresh')}
                        >
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={end} data-testid="desktop-end">
                            <X className="mr-1 h-4 w-4" aria-hidden="true" />
                            {t('end')}
                        </Button>
                        <span className="ml-auto text-xs text-muted-foreground">
                            {t('bandwidth', { amount: formatFileBytes(bytes) })}
                        </span>
                    </div>
                </footer>
            ) : null}
        </section>
    );
}

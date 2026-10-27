'use client';

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import { Monitor, RefreshCw, X } from 'lucide-react';
import {
    COMPUTER_QUALITIES,
    COMPUTER_STALL_AFTER_MS,
    COMPUTER_DEAD_AFTER_MS,
    fleetDesktopWatermark,
    type ComputerInputFrame,
    type ComputerQuality,
    type FleetDesktopAvailabilityView,
    type FleetDisplayView,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import type { FleetComputerTabProps } from '../registry';
import {
    COMPUTER_ESCAPE_TWICE_WINDOW_MS,
    keyEventToFrame,
    pointerButtonsMask,
    pointerToPicture,
} from '../../computer/computer-session.shared';
import { formatFileBytes } from '../files/files.shared';
import { useNow } from '../health/use-now';
import { DesktopControlBar } from './DesktopControlBar';
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
import { useDesktopControl } from './use-desktop-control';

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
 *
 * Control (P2, FR-36 … FR-42): Take control → a confirmation → the platform's
 * arbiter → a `driver` grant the tab re-attaches with; only then do the
 * pointer, the wheel and the keyboard on the stage reach the machine (the
 * blocked shortcuts never leave the browser, and the strip names them).
 * Escape twice, Give back control, an idle minute-count running out, the
 * ceiling, or someone handed control re-attach the tab watching. Recordings
 * and the split beside a terminal arrive with the next phase of this epic.
 */

/** Pointer moves sent at most this often while driving (the machine drops nothing it needs). */
const POINTER_MOVE_EVERY_MS = 33;

type Phase =
    | 'checking'
    | 'unavailable'
    | 'ready'
    | 'opening'
    | 'connecting'
    | 'live'
    | 'stalled'
    | 'ended';

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
    /** P2: the role of the grant the socket attached with (input goes only on a `driver` one). */
    const grantRoleRef = useRef<'viewer' | 'driver'>('viewer');
    const [grantRole, setGrantRole] = useState<'viewer' | 'driver'>('viewer');
    const stageRef = useRef<HTMLDivElement | null>(null);
    const lastMoveRef = useRef(0);
    const lastEscapeRef = useRef(0);
    const pressedRef = useRef<'left' | 'middle' | 'right' | null>(null);
    const [inputNotice, setInputNotice] = useState<string | null>(null);
    const nowMs = useNow(1_000);

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

    const reconnectRef = useRef<() => void>(() => undefined);

    const attachTo = useCallback(
        (grant: DesktopBrowserGrant) => {
            closeSocket();
            leavingRef.current = false;
            grantRoleRef.current = grant.role === 'driver' ? 'driver' : 'viewer';
            setGrantRole(grantRoleRef.current);
            const painter = new DesktopPainter({
                canvas: () => canvasRef.current,
                requestKeyframe: () => socketRef.current?.refresh(),
                painted: () => {
                    lastPaintRef.current = Date.now();
                    setPhase((current) =>
                        current === 'connecting' || current === 'stalled' ? 'live' : current,
                    );
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
                onInputRefused: (code) =>
                    setInputNotice(t(`control.refused.${desktopInputNoticeKey(code)}`)),
                onClosed: (close) => {
                    if (socketRef.current !== socket) return;
                    socketRef.current = null;
                    if (leavingRef.current) return;
                    // A driver socket the platform closed (control ended): carry on watching.
                    if (grantRoleRef.current === 'driver' && close.wasReady) {
                        reconnectRef.current();
                        return;
                    }
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

    useEffect(() => {
        reconnectRef.current = () => void reconnect();
    }, [reconnect]);

    const control = useDesktopControl({
        nodeId: node.id,
        viewId,
        enabled:
            viewId !== null && (phase === 'live' || phase === 'stalled' || phase === 'connecting'),
        onGrant: attachTo,
    });
    const driving =
        grantRole === 'driver' && control.state?.mode === 'controlling' && phase === 'live';

    // Taking control moves the keyboard onto the stage at once.
    useEffect(() => {
        if (driving) stageRef.current?.focus();
        else setInputNotice(null);
    }, [driving]);

    const sendInput = useCallback((input: ComputerInputFrame) => {
        socketRef.current?.sendInput(input);
    }, []);

    const forwardPointer = (
        event: ReactPointerEvent<HTMLCanvasElement>,
        action: 'move' | 'down' | 'up',
    ) => {
        if (!driving) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (action === 'move') {
            const at = Date.now();
            if (at - lastMoveRef.current < POINTER_MOVE_EVERY_MS) return;
            lastMoveRef.current = at;
        }
        const point = pointerToPicture(event, canvas.getBoundingClientRect(), canvas, {
            clamp: action === 'up',
        });
        if (!point) return;
        event.preventDefault();
        const button =
            action === 'move'
                ? null
                : event.button === 1
                  ? 'middle'
                  : event.button === 2
                    ? 'right'
                    : 'left';
        if (action === 'down') {
            pressedRef.current = button;
            try {
                canvas.setPointerCapture?.(event.pointerId);
            } catch {
                // a pointer that is already gone cannot be captured
            }
        } else if (action === 'up') {
            pressedRef.current = null;
        }
        sendInput({
            kind: 'pointer',
            action,
            ...point,
            button,
            buttons: pointerButtonsMask(event.buttons),
        });
    };

    const forwardKey = (event: ReactKeyboardEvent<HTMLDivElement>, action: 'down' | 'up') => {
        if (!driving) return;
        if (action === 'down' && event.key === 'Escape') {
            const at = Date.now();
            if (at - lastEscapeRef.current <= COMPUTER_ESCAPE_TWICE_WINDOW_MS) {
                lastEscapeRef.current = 0;
                event.preventDefault();
                void control.giveBack();
                return;
            }
            lastEscapeRef.current = at;
        }
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        // A blocked shortcut is never sent (`keyEventToFrame` answers null for it).
        const frame = keyEventToFrame(event, action);
        if (frame) sendInput(frame);
    };

    // The wheel needs a non-passive listener so the page itself does not scroll.
    useEffect(() => {
        const stage = stageRef.current;
        if (!driving || !stage) return;
        const onWheel = (event: WheelEvent) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const point = pointerToPicture(event, canvas.getBoundingClientRect(), canvas);
            if (!point) return;
            event.preventDefault();
            sendInput({
                kind: 'scroll',
                ...point,
                dx: Math.max(-10_000, Math.min(10_000, Math.round(event.deltaX))),
                dy: Math.max(-10_000, Math.min(10_000, Math.round(event.deltaY))),
            });
        };
        stage.addEventListener('wheel', onWheel, { passive: false });
        return () => stage.removeEventListener('wheel', onWheel);
    }, [driving, sendInput]);

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

    const watching =
        phase === 'connecting' || phase === 'live' || phase === 'stalled' || phase === 'ended';
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
            <DesktopHelperNote
                nodeName={name}
                trust={trust}
                helper={availability?.helper ?? null}
            />
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
                    <p className="max-w-lg text-sm text-muted-foreground">
                        {t('watchHint', { name })}
                    </p>
                    <Button
                        type="button"
                        onClick={() => void watch()}
                        disabled={phase === 'opening'}
                        data-testid="desktop-watch"
                    >
                        {phase === 'opening' ? t('opening') : t('watch')}
                    </Button>
                </div>
            ) : (
                <div
                    ref={stageRef}
                    className={`relative overflow-hidden rounded-lg border bg-black outline-none ${
                        driving ? 'border-amber-500 ring-2 ring-amber-500' : 'border-border'
                    }`}
                    role="region"
                    tabIndex={0}
                    aria-label={t('stage.label', { name })}
                    data-testid="desktop-stage"
                    onKeyDown={(event) => forwardKey(event, 'down')}
                    onKeyUp={(event) => forwardKey(event, 'up')}
                >
                    <canvas
                        ref={canvasRef}
                        className={`mx-auto block h-auto max-w-full ${phase === 'stalled' ? 'opacity-50' : ''} ${
                            driving ? 'cursor-crosshair touch-none select-none' : ''
                        }`}
                        onPointerDown={(event) => forwardPointer(event, 'down')}
                        onPointerMove={(event) => forwardPointer(event, 'move')}
                        onPointerUp={(event) => forwardPointer(event, 'up')}
                        onPointerCancel={(event) => {
                            if (pressedRef.current) forwardPointer(event, 'up');
                        }}
                        onContextMenu={(event) => {
                            if (driving) event.preventDefault();
                        }}
                    />
                    <span className="pointer-events-none absolute bottom-2 right-3 text-[10px] font-semibold uppercase tracking-wide text-white/70">
                        {fleetDesktopWatermark(name)}
                    </span>
                    {phase === 'connecting' ? (
                        <p
                            className="absolute inset-0 flex items-center justify-center text-sm text-white/80"
                            role="status"
                        >
                            {t('connecting', { name })}
                        </p>
                    ) : null}
                    {phase === 'stalled' ? (
                        <p
                            className="absolute inset-x-0 top-3 text-center text-sm text-white"
                            role="status"
                        >
                            {t('stalled')}
                        </p>
                    ) : null}
                    {phase === 'ended' ? (
                        <div
                            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-white"
                            role="status"
                        >
                            <p className="text-sm">{t('ended')}</p>
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={() => void reconnect()}
                            >
                                {t('reconnect')}
                            </Button>
                        </div>
                    ) : null}
                </div>
            )}

            {watching ? (
                <footer className="flex flex-col gap-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                        {control.state?.mode !== 'controlling' && !control.state?.holder ? (
                            <span data-testid="desktop-status">
                                {t('status.watching', { name })}
                            </span>
                        ) : (
                            <span />
                        )}
                        <span>{t('noCredits')}</span>
                    </div>
                    {viewId && phase !== 'ended' ? (
                        <DesktopControlBar
                            nodeName={name}
                            state={control.state}
                            availability={availability?.control}
                            busy={control.busy}
                            nowMs={nowMs}
                            serverOffsetMs={control.serverOffsetMs}
                            refusal={control.refusal}
                            onTake={() => void control.take()}
                            onRequest={() => void control.request()}
                            onGiveBack={() => void control.giveBack()}
                            onKeep={() => void control.keep()}
                            onExtend={() => void control.extend()}
                            onAnswer={(decision) => void control.answer(decision)}
                        />
                    ) : null}
                    {inputNotice ? (
                        <p className="text-xs text-amber-700" role="status">
                            {inputNotice}
                        </p>
                    ) : null}
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
                                onChange={(event) =>
                                    changeQuality(event.target.value as ComputerQuality)
                                }
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
                            variant="secondary"
                            onClick={() => socketRef.current?.refresh()}
                            aria-label={t('refresh')}
                        >
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={end}
                            data-testid="desktop-end"
                        >
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

/** The i18n leaf (under `fleet.desktop.control.refused`) of an input the machine did not take. */
function desktopInputNoticeKey(
    code:
        | 'blocked-shortcut'
        | 'not-controlling'
        | 'control-not-allowed'
        | 'permission-accessibility'
        | 'input-unavailable'
        | 'inject-failed',
):
    | 'blockedShortcut'
    | 'notControlling'
    | 'controlNotAllowed'
    | 'permissionAccessibility'
    | 'inputUnavailable'
    | 'injectFailed' {
    switch (code) {
        case 'blocked-shortcut':
            return 'blockedShortcut';
        case 'not-controlling':
            return 'notControlling';
        case 'control-not-allowed':
            return 'controlNotAllowed';
        case 'permission-accessibility':
            return 'permissionAccessibility';
        case 'input-unavailable':
            return 'inputUnavailable';
        default:
            return 'injectFailed';
    }
}

'use client';

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type PointerEvent,
    type WheelEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw, X } from 'lucide-react';
import {
    fleetPortPreviewWatermark,
    type ComputerInputFrame,
    type ComputerPointerButton,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { useNow } from '../health/use-now';
import { FleetPreviewSocket, type PreviewSocketClose } from './preview-socket';
import { timeLeft } from './ports.shared';

/**
 * Servers and ports (FL-10, spec §5.2, S4, FR-10) — the preview pane: the
 * page as the machine's PREVIEW browser renders it, driven by the person who
 * opened it.
 *
 * ```
 * Preview · build-01 · :3000 · preview profile                 ● LIVE  [ ↻ ] [ ✕ ]
 * ( the page )                               EVER WORKS · PREVIEW · build-01 · :3000
 * You are driving the preview browser on build-01. It is yours — no agent uses this profile.
 * Ends when you leave, or in 59:12.
 * ```
 *
 * The picture arrives on the viewer socket the Open answer's token opens
 * (`preview-socket.ts`); pointer, wheel, keys and text go back as input in
 * PICTURE pixels (the node scales them to the page). Closing the pane closes
 * the socket — the machine ends the preview 15 s later (FR-10).
 */
export function PreviewPane({
    nodeName,
    port,
    attach,
    endsAt,
    onClose,
}: {
    nodeName: string;
    port: number;
    attach: { token: string; wsUrl: string };
    endsAt: string | null;
    onClose: () => void;
}) {
    const t = useTranslations('fleet.ports.preview');
    const nowMs = useNow(1_000);
    const [picture, setPicture] = useState<{ src: string; width: number; height: number } | null>(
        null,
    );
    const [phase, setPhase] = useState<'connecting' | 'live' | 'ended'>('connecting');
    const [ended, setEnded] = useState<PreviewSocketClose | null>(null);
    const socketRef = useRef<FleetPreviewSocket | null>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const buttonsRef = useRef(0);

    useEffect(() => {
        const socket = new FleetPreviewSocket(attach.wsUrl, attach.token, {
            onReady: () => setPhase('live'),
            onPicture: (next) => setPicture(next),
            onClosed: (close) => {
                setPhase('ended');
                setEnded(close);
            },
        });
        socketRef.current = socket;
        socket.open();
        return () => {
            socketRef.current = null;
            socket.close();
        };
    }, [attach.token, attach.wsUrl]);

    /** Page coordinates → picture pixels (the node maps those to the page). */
    const toPicture = useCallback(
        (clientX: number, clientY: number): { x: number; y: number } | null => {
            const image = imageRef.current;
            if (!image || !picture) return null;
            const rect = image.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            const x = Math.round(((clientX - rect.left) / rect.width) * picture.width);
            const y = Math.round(((clientY - rect.top) / rect.height) * picture.height);
            return {
                x: Math.min(Math.max(0, x), picture.width - 1),
                y: Math.min(Math.max(0, y), picture.height - 1),
            };
        },
        [picture],
    );

    const send = (input: ComputerInputFrame) => socketRef.current?.sendInput(input);
    const buttonOf = (button: number): ComputerPointerButton =>
        button === 1 ? 'middle' : button === 2 ? 'right' : 'left';

    const onPointer = (action: 'move' | 'down' | 'up', event: PointerEvent<HTMLImageElement>) => {
        const at = toPicture(event.clientX, event.clientY);
        if (!at) return;
        // Hover moves are sent too: a page's menus open on hover.
        buttonsRef.current = event.buttons;
        send({
            kind: 'pointer',
            action,
            x: at.x,
            y: at.y,
            button: action === 'move' ? null : buttonOf(event.button),
            buttons: event.buttons,
        });
    };

    const onWheel = (event: WheelEvent<HTMLImageElement>) => {
        const at = toPicture(event.clientX, event.clientY);
        if (!at) return;
        send({
            kind: 'scroll',
            x: at.x,
            y: at.y,
            dx: Math.round(event.deltaX),
            dy: Math.round(event.deltaY),
        });
    };

    const modifiers = (event: KeyboardEvent) =>
        (event.altKey ? 1 : 0) |
        (event.ctrlKey ? 2 : 0) |
        (event.metaKey ? 4 : 0) |
        (event.shiftKey ? 8 : 0);

    const onKey = (action: 'down' | 'up', event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape' && action === 'down') {
            onClose();
            return;
        }
        event.preventDefault();
        if (
            action === 'down' &&
            event.key.length === 1 &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
        ) {
            send({ kind: 'text', text: event.key });
            return;
        }
        if (event.key.length > 32 || event.code.length > 32) return;
        send({
            kind: 'key',
            action,
            key: event.key,
            code: event.code,
            modifiers: modifiers(event),
        });
    };

    const left = timeLeft(endsAt, nowMs);
    const watermark = fleetPortPreviewWatermark(nodeName, port);

    return (
        <section
            className="rounded-lg border border-border dark:border-border-dark"
            aria-label={t('a11y', { name: nodeName, port })}
            data-testid="fleet-port-preview"
        >
            <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm dark:border-border-dark">
                <span className="font-medium">{t('title', { name: nodeName, port })}</span>
                {phase === 'live' && (
                    <span className="ml-auto flex items-center gap-1 text-xs font-semibold text-success">
                        <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
                        {t('live')}
                    </span>
                )}
                <span className={phase === 'live' ? '' : 'ml-auto'}>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('refresh')}
                        disabled={phase !== 'live'}
                        onClick={() => socketRef.current?.refresh()}
                    >
                        <RefreshCw className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={t('close')} onClick={onClose}>
                        <X className="h-4 w-4" aria-hidden />
                    </Button>
                </span>
            </header>
            <div
                className="relative bg-surface-secondary outline-none dark:bg-surface-secondary-dark"
                tabIndex={0}
                onKeyDown={(event) => onKey('down', event)}
                onKeyUp={(event) => onKey('up', event)}
            >
                {picture ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        ref={imageRef}
                        src={picture.src}
                        width={picture.width}
                        height={picture.height}
                        alt={t('a11y', { name: nodeName, port })}
                        className="block h-auto w-full select-none"
                        draggable={false}
                        onPointerDown={(event) => onPointer('down', event)}
                        onPointerUp={(event) => onPointer('up', event)}
                        onPointerMove={(event) => onPointer('move', event)}
                        onWheel={onWheel}
                        onContextMenu={(event) => event.preventDefault()}
                    />
                ) : (
                    <p className="p-8 text-center text-sm text-text-muted dark:text-text-muted-dark">
                        {phase === 'ended' ? t('ended') : t('connecting', { name: nodeName })}
                    </p>
                )}
                <span className="pointer-events-none absolute bottom-2 right-3 text-[10px] font-semibold tracking-wide text-text-muted opacity-70 dark:text-text-muted-dark">
                    {watermark}
                </span>
            </div>
            <footer className="space-y-1 px-3 py-2 text-xs text-text-muted dark:text-text-muted-dark">
                {phase === 'ended' ? (
                    <p>{ended?.hint ?? t('ended')}</p>
                ) : (
                    <>
                        <p>{t('driving', { name: nodeName })}</p>
                        {left && <p>{t('endsIn', { time: left })}</p>}
                    </>
                )}
            </footer>
        </section>
    );
}

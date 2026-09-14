'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import type { ComputerChannel, ComputerScreenFrame, TerminalFrame } from '@ever-works/contracts';
import { createTerminalRenderer } from '@/components/terminal/create-terminal-renderer';
import type { TerminalRenderer } from '@/components/terminal/terminal-renderer';
import { cn } from '@/lib/utils/cn';
import type { ComputerStallState } from './computer-session.shared';

/** What the page pushes into the stage as frames arrive (outside React state — pictures are hot). */
export interface ComputerStageHandle {
    drawPicture(frame: ComputerScreenFrame): void;
    writeTerminal(frame: TerminalFrame): void;
}

interface Props {
    channel: ComputerChannel;
    label: string;
    stall: ComputerStallState;
    /** Whole seconds since the last frame, for the stall banner. */
    staleSeconds: number;
    onRefresh: () => void;
    onReconnect: () => void;
    /** Overlays: the watermark and the working brief. */
    children?: ReactNode;
    /** Seam for tests: jsdom has neither `createImageBitmap` nor a 2D context. */
    decodePicture?: (
        frame: ComputerScreenFrame,
    ) => Promise<CanvasImageSource & { width: number; height: number }>;
    createRenderer?: () => Promise<TerminalRenderer>;
}

/** Consecutive undecodable pictures after which the stage asks for a fresh one. */
const DECODE_FAILURES_BEFORE_REFRESH = 3;

async function defaultDecode(frame: ComputerScreenFrame): Promise<ImageBitmap> {
    const binary = atob(frame.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return createImageBitmap(new Blob([bytes], { type: frame.mime }));
}

/**
 * The stage: a labelled, focusable region that shows the Agent's browser on
 * a `<canvas>` (scaled to fit, never up, never cropped) or the computer's
 * shell through the SAME terminal renderer the Agent Terminal tab uses.
 *
 * A stalled stream never shows a blank rectangle: the last picture stays,
 * dimmed, with its age and a Refresh; at the dead line it says the stream
 * stopped and offers Reconnect. A picture that cannot be decoded is dropped;
 * three in a row ask the computer for a fresh one.
 */
export const ComputerStage = forwardRef<ComputerStageHandle, Props>(function ComputerStage(
    {
        channel,
        label,
        stall,
        staleSeconds,
        onRefresh,
        onReconnect,
        children,
        decodePicture,
        createRenderer,
    },
    ref,
) {
    const t = useTranslations('dashboard.computer');
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const terminalHostRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<TerminalRenderer | null>(null);
    const pendingTerminalRef = useRef<Uint8Array[]>([]);
    const decodeFailuresRef = useRef(0);
    const onRefreshRef = useRef(onRefresh);
    // Synced after render (never during it), so a decode failure always calls the latest handler.
    useEffect(() => {
        onRefreshRef.current = onRefresh;
    }, [onRefresh]);

    useImperativeHandle(
        ref,
        () => ({
            drawPicture(frame) {
                const decode = decodePicture ?? defaultDecode;
                void decode(frame)
                    .then((image) => {
                        decodeFailuresRef.current = 0;
                        const canvas = canvasRef.current;
                        if (!canvas) return;
                        if (canvas.width !== image.width) canvas.width = image.width;
                        if (canvas.height !== image.height) canvas.height = image.height;
                        canvas.getContext('2d')?.drawImage(image, 0, 0);
                    })
                    .catch(() => {
                        decodeFailuresRef.current += 1;
                        if (decodeFailuresRef.current >= DECODE_FAILURES_BEFORE_REFRESH) {
                            decodeFailuresRef.current = 0;
                            onRefreshRef.current();
                        }
                    });
            },
            writeTerminal(frame) {
                if (frame.kind !== 'stdout') return;
                const binary = atob(frame.data);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
                if (rendererRef.current) rendererRef.current.write(bytes);
                else pendingTerminalRef.current.push(bytes);
            },
        }),
        [decodePicture],
    );

    useEffect(() => {
        if (channel !== 'terminal') return;
        let disposed = false;
        let renderer: TerminalRenderer | null = null;
        void (createRenderer ?? createTerminalRenderer)().then((created) => {
            if (disposed || !terminalHostRef.current) {
                created.dispose();
                return;
            }
            renderer = created;
            created.mount(terminalHostRef.current);
            rendererRef.current = created;
            for (const bytes of pendingTerminalRef.current) created.write(bytes);
            pendingTerminalRef.current = [];
        });
        return () => {
            disposed = true;
            rendererRef.current = null;
            renderer?.dispose();
        };
    }, [channel, createRenderer]);

    const stalled = stall === 'stalled' || stall === 'auto-refresh';
    return (
        <section
            role="region"
            aria-label={label}
            tabIndex={0}
            data-testid="computer-stage"
            className="relative flex min-h-[320px] flex-1 items-center justify-center overflow-hidden rounded-lg bg-[#0b0f19] outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
            {channel === 'screen' ? (
                <canvas
                    ref={canvasRef}
                    data-testid="computer-canvas"
                    className={cn(
                        'max-h-full max-w-full object-contain transition-opacity',
                        (stalled || stall === 'dead') && 'opacity-40',
                    )}
                />
            ) : (
                <div
                    ref={terminalHostRef}
                    data-testid="computer-terminal"
                    className="h-full w-full p-2"
                />
            )}
            {stalled ? (
                // Deliberately NOT a live region. A stale picture is routine and is
                // announced once, politely, by the status line below the stage; this
                // banner's seconds counter changes every second and would otherwise
                // be read out again and again. Only the dead stream (below) interrupts.
                <div
                    data-testid="computer-stall-banner"
                    className="absolute inset-x-0 top-6 mx-auto flex w-fit flex-col items-center gap-2 rounded-md bg-black/70 px-4 py-3 text-sm text-white"
                >
                    <span>{t('stall.banner', { seconds: staleSeconds })}</span>
                    <button
                        type="button"
                        onClick={onRefresh}
                        className="inline-flex items-center gap-1 rounded border border-white/30 px-2 py-1 text-xs hover:bg-white/10"
                    >
                        <RefreshCw className="h-3 w-3" aria-hidden />
                        {t('stall.refreshNow')}
                    </button>
                </div>
            ) : null}
            {stall === 'dead' ? (
                <div
                    role="alert"
                    className="absolute inset-x-0 top-1/3 mx-auto flex w-fit flex-col items-center gap-1 rounded-md bg-black/75 px-5 py-4 text-sm text-white"
                >
                    <span className="font-medium">{t('stall.stopped')}</span>
                    <span className="text-white/75">{t('stall.stoppedDetail')}</span>
                    <button
                        type="button"
                        onClick={onReconnect}
                        className="mt-2 rounded border border-white/30 px-3 py-1 text-xs hover:bg-white/10"
                    >
                        {t('stall.reconnect')}
                    </button>
                </div>
            ) : null}
            {children}
        </section>
    );
});

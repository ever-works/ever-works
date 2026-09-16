'use client';

import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { RefreshCw } from 'lucide-react';
import type {
    ComputerChannel,
    ComputerInputFrame,
    ComputerScreenFrame,
    TerminalFrame,
} from '@ever-works/contracts';
import { createTerminalRenderer } from '@/components/terminal/create-terminal-renderer';
import type { TerminalRenderer } from '@/components/terminal/terminal-renderer';
import { cn } from '@/lib/utils/cn';
import {
    COMPUTER_ESCAPE_TWICE_WINDOW_MS,
    keyEventToFrame,
    pointerButtonsMask,
    pointerToPicture,
    type ComputerStallState,
} from './computer-session.shared';

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
    /** True while this view holds control: the stage takes pointer and keyboard and forwards them. */
    controlling?: boolean;
    /** Where forwarded input goes (the live-view socket). */
    onInput?: (frame: ComputerInputFrame) => void;
    /** Escape pressed twice: give control back. The only key the stage keeps while in control. */
    onEscapeTwice?: () => void;
}

/** Pointer moves closer together than this are coalesced (the machine gets the latest position). */
const POINTER_MOVE_INTERVAL_MS = 30;

function pointerButton(button: number): 'left' | 'middle' | 'right' | null {
    if (button === 0) return 'left';
    if (button === 1) return 'middle';
    if (button === 2) return 'right';
    return null;
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
 *
 * In control (screen channel only) the stage wears an amber border, takes
 * focus, and forwards the pointer, wheel, keys and composed text to the
 * computer in picture pixels. Escape pressed twice gives control back — the
 * only key it keeps. Pasting and dropping files are swallowed, never sent,
 * and so are the shortcuts the computer refuses.
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
        controlling = false,
        onInput,
        onEscapeTwice,
    },
    ref,
) {
    const t = useTranslations('dashboard.computer');
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const terminalHostRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<TerminalRenderer | null>(null);
    const pendingTerminalRef = useRef<Uint8Array[]>([]);
    const decodeFailuresRef = useRef(0);
    const sectionRef = useRef<HTMLElement | null>(null);
    const lastEscapeRef = useRef(0);
    const lastMoveRef = useRef(0);
    /** The last point forwarded on the picture: where a release with no point of its own lands. */
    const lastPointRef = useRef<{ x: number; y: number } | null>(null);
    /** The button pressed on the picture and not yet released. */
    const pressedButtonRef = useRef<'left' | 'middle' | 'right' | null>(null);
    const inputRef = useRef(onInput);
    const escapeTwiceRef = useRef(onEscapeTwice);
    useEffect(() => {
        inputRef.current = onInput;
        escapeTwiceRef.current = onEscapeTwice;
    }, [onInput, onEscapeTwice]);
    const driving = controlling && channel === 'screen';
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

    // Taking control moves focus onto the stage, so the keyboard drives the computer at once.
    useEffect(() => {
        if (driving) sectionRef.current?.focus();
    }, [driving]);

    // Wheel input needs a non-passive listener to keep the page itself from scrolling.
    useEffect(() => {
        const section = sectionRef.current;
        if (!driving || !section) return;
        const onWheel = (event: WheelEvent) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const point = pointerToPicture(event, canvas.getBoundingClientRect(), canvas);
            if (!point) return;
            event.preventDefault();
            inputRef.current?.({
                kind: 'scroll',
                ...point,
                dx: Math.max(-10_000, Math.min(10_000, Math.round(event.deltaX))),
                dy: Math.max(-10_000, Math.min(10_000, Math.round(event.deltaY))),
            });
        };
        section.addEventListener('wheel', onWheel, { passive: false });
        return () => section.removeEventListener('wheel', onWheel);
    }, [driving]);

    /**
     * A pointer event on the picture, forwarded. A release is NEVER dropped:
     * one off the picture is pinned to its nearest edge (the pointer is
     * captured on press, so a release outside the stage still arrives), and
     * a cancelled pointer releases the button it pressed — otherwise the
     * computer would keep that button held and carry on a drag or selection.
     * Every event carries the buttons still held, which is what makes a move
     * a drag on the computer.
     */
    const forwardPointer = (
        event: ReactPointerEvent<HTMLCanvasElement>,
        action: 'move' | 'down' | 'up',
        cancelled = false,
    ) => {
        if (!driving) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (cancelled && !pressedButtonRef.current) return;
        if (action === 'move') {
            const at = Date.now();
            if (at - lastMoveRef.current < POINTER_MOVE_INTERVAL_MS) return;
            lastMoveRef.current = at;
        }
        const releasing = action === 'up';
        // A cancelled pointer has no meaningful position: release where it last was.
        const point = cancelled
            ? lastPointRef.current
            : (pointerToPicture(event, canvas.getBoundingClientRect(), canvas, {
                  clamp: releasing,
              }) ?? (releasing ? lastPointRef.current : null));
        if (!point) return;
        event.preventDefault();
        lastPointRef.current = point;
        const button =
            action === 'move'
                ? null
                : cancelled
                  ? pressedButtonRef.current
                  : pointerButton(event.button);
        const buttons = cancelled ? 0 : pointerButtonsMask(event.buttons);
        if (action === 'down') {
            pressedButtonRef.current = button;
            try {
                canvas.setPointerCapture?.(event.pointerId);
            } catch {
                // a pointer that is already gone cannot be captured
            }
        } else if (releasing && buttons === 0) {
            pressedButtonRef.current = null;
        }
        inputRef.current?.({ kind: 'pointer', action, ...point, button, buttons });
    };

    const forwardKey = (event: ReactKeyboardEvent<HTMLElement>, action: 'down' | 'up') => {
        if (!driving) return;
        if (action === 'down' && event.key === 'Escape') {
            const at = Date.now();
            if (at - lastEscapeRef.current <= COMPUTER_ESCAPE_TWICE_WINDOW_MS) {
                lastEscapeRef.current = 0;
                event.preventDefault();
                escapeTwiceRef.current?.();
                return;
            }
            lastEscapeRef.current = at;
        }
        if (event.nativeEvent.isComposing) return;
        const frame = keyEventToFrame(event, action);
        event.preventDefault();
        event.stopPropagation();
        if (frame) inputRef.current?.(frame);
    };

    const stalled = stall === 'stalled' || stall === 'auto-refresh';
    return (
        <section
            ref={sectionRef}
            role="region"
            aria-label={label}
            tabIndex={0}
            data-testid="computer-stage"
            data-controlling={driving ? 'true' : undefined}
            onKeyDown={(event) => forwardKey(event, 'down')}
            onKeyUp={(event) => forwardKey(event, 'up')}
            onCompositionEnd={(event) => {
                if (driving && event.data)
                    inputRef.current?.({ kind: 'text', text: event.data.slice(0, 4096) });
            }}
            onPaste={(event) => {
                // Clipboard contents never leave this computer.
                if (driving) event.preventDefault();
            }}
            onDrop={(event) => {
                if (driving) event.preventDefault();
            }}
            onDragOver={(event) => {
                if (driving) event.preventDefault();
            }}
            onContextMenu={(event) => {
                if (driving) event.preventDefault();
            }}
            className={cn(
                'relative flex min-h-[320px] flex-1 items-center justify-center overflow-hidden rounded-lg bg-[#0b0f19] outline-none focus-visible:ring-2 focus-visible:ring-primary',
                driving &&
                    'ring-4 ring-amber-500 focus-visible:ring-4 focus-visible:ring-amber-500',
            )}
        >
            {channel === 'screen' ? (
                <canvas
                    ref={canvasRef}
                    data-testid="computer-canvas"
                    onPointerMove={(event) => forwardPointer(event, 'move')}
                    onPointerDown={(event) => forwardPointer(event, 'down')}
                    onPointerUp={(event) => forwardPointer(event, 'up')}
                    onPointerCancel={(event) => forwardPointer(event, 'up', true)}
                    className={cn(
                        'max-h-full max-w-full object-contain transition-opacity',
                        (stalled || stall === 'dead') && 'opacity-40',
                        driving && 'cursor-default touch-none',
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

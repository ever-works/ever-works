'use client';

import { useEffect, useRef, type MutableRefObject } from 'react';
import type { TerminalRenderer } from '@/components/terminal/terminal-renderer';
import { createTerminalRenderer } from '@/components/terminal/create-terminal-renderer';

/** Two Escapes this close together release the keyboard (spec FR-60). */
const ESC_ESC_MS = 600;

/**
 * Sessions on computers (FL-04 P1b) — the terminal surface of the session
 * page: the shared renderer (xterm, or its DOM floor) mounted imperatively
 * into a React-child-free host (the black-terminal rule `TerminalPane`
 * documents), keystrokes and sizes handed to the attach hook, and the one key
 * this page intercepts while you drive: **Esc Esc** leaves the terminal
 * (focus moves to `onRelease`'s target), every other key reaches the session.
 *
 * The host is a labelled region (`ariaLabel`), re-announced by the page when
 * the role changes.
 */
export function SessionTerminal({
    rendererRef,
    onData,
    onResize,
    onRelease,
    ariaLabel,
    createRenderer,
}: {
    rendererRef: MutableRefObject<TerminalRenderer | null>;
    onData: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    onRelease: () => void;
    ariaLabel: string;
    createRenderer?: () => Promise<TerminalRenderer>;
}) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const handlers = useRef({ onData, onResize, onRelease });
    handlers.current = { onData, onResize, onRelease };

    useEffect(() => {
        let disposed = false;
        const factory = createRenderer ?? createTerminalRenderer;
        void factory().then((renderer) => {
            if (disposed || !hostRef.current) {
                renderer.dispose();
                return;
            }
            rendererRef.current = renderer;
            renderer.mount(hostRef.current);
            renderer.onData((data) => handlers.current.onData(data));
            renderer.onResize(({ cols, rows }) => handlers.current.onResize(cols, rows));
            renderer.fit();
        });
        return () => {
            disposed = true;
            rendererRef.current?.dispose();
            rendererRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Re-fit when the host resizes (debounced, the pane's reflow guard).
    useEffect(() => {
        const host = hostRef.current;
        if (!host || typeof ResizeObserver === 'undefined') return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const observer = new ResizeObserver(() => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => rendererRef.current?.fit(), 120);
        });
        observer.observe(host);
        return () => {
            observer.disconnect();
            if (timer) clearTimeout(timer);
        };
    }, [rendererRef]);

    // Esc Esc: the only key the page keeps while the terminal has the keyboard.
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let lastEscape = 0;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') {
                lastEscape = 0;
                return;
            }
            const now = Date.now();
            if (now - lastEscape <= ESC_ESC_MS) {
                event.preventDefault();
                event.stopPropagation();
                lastEscape = 0;
                (document.activeElement as HTMLElement | null)?.blur?.();
                handlers.current.onRelease();
                return;
            }
            lastEscape = now;
        };
        host.addEventListener('keydown', onKeyDown, true);
        return () => host.removeEventListener('keydown', onKeyDown, true);
    }, []);

    return (
        <section
            aria-label={ariaLabel}
            className="relative min-h-[360px] h-[60vh] rounded-md overflow-hidden bg-[#0b0f19]"
            data-testid="fleet-session-terminal"
        >
            {/* The renderer owns this node's children — React never renders inside it. */}
            <div
                ref={hostRef}
                className="absolute inset-0"
                data-testid="fleet-session-terminal-host"
            />
        </section>
    );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, RotateCw, ShieldOff } from 'lucide-react';
import type { TerminalRenderer } from './terminal-renderer';
import { createTerminalRenderer } from './create-terminal-renderer';
import {
    useTerminalAttach,
    type TerminalAttachDeps,
    type TerminalAttachState,
} from './use-terminal-attach';

/**
 * The live terminal pane (streaming-terminal M7).
 *
 * Hard rules encoded here:
 *  - the renderer mount `<div ref>` is strictly React-child-free —
 *    React reconciliation wiping imperatively-injected xterm DOM is the
 *    classic black-terminal trap; the "waiting" overlay is a SIBLING
 *    with pointer-events-none, never a child;
 *  - all five attach states render visibly distinct UI; `refused` is
 *    a permissions message, `cannot-connect` an infrastructure one;
 *  - viewers get a read-only badge, their keystrokes never leave the
 *    hook (role-gated there, refused again relay-side).
 */
export interface TerminalPaneProps {
    agentId: string;
    runId: string;
    /** Injectable for tests: renderer + network seams. */
    createRenderer?: () => Promise<TerminalRenderer>;
    attachDeps?: TerminalAttachDeps;
    /**
     * Attach read-only — mints a `viewer` token, so this pane watches a
     * session someone else is driving instead of taking the keyboard.
     */
    readOnly?: boolean;
}

export function TerminalPane({
    agentId,
    runId,
    createRenderer,
    attachDeps,
    readOnly,
}: TerminalPaneProps) {
    const t = useTranslations('dashboard.terminal');
    const hostRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<TerminalRenderer | null>(null);
    const [rendererReady, setRendererReady] = useState(false);
    const [sawOutput, setSawOutput] = useState(false);

    const attach = useTerminalAttach(
        agentId,
        runId,
        {
            onBytes: (bytes) => {
                rendererRef.current?.write(bytes);
                setSawOutput(true);
            },
            onBanner: (message) => {
                rendererRef.current?.write(new TextEncoder().encode(`\r\n[${message}]\r\n`));
            },
        },
        attachDeps,
        { readOnly: readOnly === true },
    );

    // Mount the renderer imperatively, once, into the child-free host.
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
            renderer.onData((data) => attachRef.current.sendInput(data));
            renderer.onResize(({ cols, rows }) => attachRef.current.sendResize(cols, rows));
            setRendererReady(true);
        });
        return () => {
            disposed = true;
            rendererRef.current?.dispose();
            rendererRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runId]);

    // Latest attach api for the renderer callbacks without re-mounting.
    const attachRef = useRef(attach);
    attachRef.current = attach;

    // Debounced re-fit on host resize (reflow-corruption guard).
    useEffect(() => {
        if (!rendererReady || !hostRef.current) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const observer = new ResizeObserver(() => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => rendererRef.current?.fit(), 120);
        });
        observer.observe(hostRef.current);
        return () => {
            observer.disconnect();
            if (timer) clearTimeout(timer);
        };
    }, [rendererReady]);

    return (
        <div className="flex flex-col h-full min-h-[320px]" data-testid="terminal-pane">
            <StatusBar
                state={attach.state}
                endedReason={attach.endedReason}
                role={attach.role}
                onReconnect={attach.reconnect}
            />
            <div className="relative flex-1 min-h-0 rounded-b-md overflow-hidden bg-[#0b0f19]">
                {/* The renderer owns this node's children — React must never
                    render inside it (black-terminal trap). */}
                <div ref={hostRef} className="absolute inset-0" data-testid="terminal-host" />
                {!sawOutput && attach.state === 'attached' && (
                    <div
                        className="absolute inset-0 flex items-center justify-center pointer-events-none text-xs text-gray-500"
                        data-testid="terminal-waiting-overlay"
                    >
                        {t('waitingForOutput')}
                    </div>
                )}
            </div>
        </div>
    );
}

function StatusBar({
    state,
    endedReason,
    role,
    onReconnect,
}: {
    state: TerminalAttachState;
    endedReason: string | null;
    role: 'driver' | 'viewer' | null;
    onReconnect: () => void;
}) {
    const t = useTranslations('dashboard.terminal');
    return (
        <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-t-md border border-b-0 border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark text-xs"
            role="status"
            aria-live="polite"
            data-testid="terminal-status"
            data-state={state}
        >
            {state === 'starting' && (
                <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    <span>{t('stateStarting')}</span>
                </>
            )}
            {state === 'attached' && (
                <>
                    <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                    <span>{t('stateAttached')}</span>
                    {role === 'viewer' && (
                        <span
                            className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400"
                            data-testid="terminal-readonly-badge"
                        >
                            {t('readOnly')}
                        </span>
                    )}
                </>
            )}
            {state === 'ended' && (
                <>
                    <span className="h-2 w-2 rounded-full bg-gray-400" aria-hidden="true" />
                    <span>{t('stateEnded', { reason: endedReason ?? 'closed' })}</span>
                </>
            )}
            {state === 'cannot-connect' && (
                <>
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
                    <span>{t('stateCannotConnect')}</span>
                </>
            )}
            {state === 'refused' && (
                <>
                    <ShieldOff className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />
                    <span>{t('stateRefused')}</span>
                </>
            )}
            {(state === 'cannot-connect' || state === 'ended') && (
                <button
                    type="button"
                    onClick={onReconnect}
                    className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-card-hover dark:hover:bg-card-hover-dark"
                    data-testid="terminal-reconnect"
                >
                    <RotateCw className="h-3 w-3" aria-hidden="true" />
                    {t('reconnect')}
                </button>
            )}
        </div>
    );
}

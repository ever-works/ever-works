import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, string>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));

import { TerminalPane } from './TerminalPane';
import type { TerminalRenderer } from './terminal-renderer';

/**
 * Injected-seam suite: a fake renderer (never mount real xterm in
 * jsdom) + a scripted WebSocket + fetch. Pins the five-state machine,
 * the React-child-free mount rule, and the read-only badge.
 */
function makeFakeRenderer(): TerminalRenderer & { written: string[] } {
    const written: string[] = [];
    return {
        kind: 'dom',
        written,
        mount: vi.fn(),
        write: (data: Uint8Array) => {
            written.push(new TextDecoder().decode(data));
        },
        onData: vi.fn(),
        onResize: vi.fn(),
        fit: vi.fn(),
        focus: vi.fn(),
        clear: vi.fn(),
        dispose: vi.fn(),
    };
}

class ScriptedSocket {
    static instances: ScriptedSocket[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    sent: string[] = [];
    readyState = 1;
    OPEN = 1;
    constructor(public url: string) {
        ScriptedSocket.instances.push(this);
        queueMicrotask(() => this.onopen?.());
    }
    send(data: string) {
        this.sent.push(data);
    }
    close() {
        this.onclose?.({ code: 1000 });
    }
    emit(frame: unknown) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
}

function okTokenFetch(role = 'driver'): typeof fetch {
    return vi.fn(
        async () =>
            new Response(
                JSON.stringify({
                    token: 'tok',
                    wsUrl: 'ws://x/ws/terminal/r',
                    role,
                    expiresInSec: 60,
                }),
                { status: 200 },
            ),
    ) as unknown as typeof fetch;
}

const AGENT = '11111111-2222-4333-8444-555555555555';
const RUN = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';

describe('TerminalPane', () => {
    beforeEach(() => {
        ScriptedSocket.instances = [];
    });

    function renderPane(fetchImpl: typeof fetch, renderer = makeFakeRenderer()) {
        render(
            <TerminalPane
                agentId={AGENT}
                runId={RUN}
                createRenderer={async () => renderer}
                attachDeps={{
                    fetchImpl,
                    webSocketImpl: ScriptedSocket as unknown as typeof WebSocket,
                }}
            />,
        );
        return renderer;
    }

    it('reaches attached, keeps the mount node React-child-free, and renders live bytes', async () => {
        const renderer = renderPane(okTokenFetch());

        await waitFor(() =>
            expect(screen.getByTestId('terminal-status')).toHaveAttribute('data-state', 'attached'),
        );
        // The auth frame was the FIRST message on the socket.
        const socket = ScriptedSocket.instances[0];
        expect(JSON.parse(socket.sent[0])).toMatchObject({ kind: 'auth', token: 'tok' });
        // React renders NOTHING inside the renderer host.
        expect(screen.getByTestId('terminal-host').childElementCount).toBe(0);

        socket.emit({ kind: 'stdout', seq: 0, data: btoa('hello-pane') });
        await waitFor(() => expect(renderer.written.join('')).toContain('hello-pane'));
    });

    it('shows ended with the reason when the pinned exit arrives', async () => {
        renderPane(okTokenFetch());
        await waitFor(() => expect(ScriptedSocket.instances).toHaveLength(1));
        ScriptedSocket.instances[0].emit({ kind: 'exit', code: 0, reason: 'parked' });

        await waitFor(() =>
            expect(screen.getByTestId('terminal-status')).toHaveAttribute('data-state', 'ended'),
        );
        expect(screen.getByTestId('terminal-status').textContent).toContain('parked');
        // Reconnect affordance present on ended.
        expect(screen.getByTestId('terminal-reconnect')).toBeInTheDocument();
    });

    it('refused (403) and cannot-connect (503) are DISTINCT states', async () => {
        const refused = vi.fn(async () => new Response('{}', { status: 403 })) as never;
        renderPane(refused);
        await waitFor(() =>
            expect(screen.getByTestId('terminal-status')).toHaveAttribute('data-state', 'refused'),
        );
    });

    it('surface cannot-connect on a 503 token mint (unprovisioned install)', async () => {
        const unavailable = vi.fn(async () => new Response('{}', { status: 503 })) as never;
        renderPane(unavailable);
        await waitFor(() =>
            expect(screen.getByTestId('terminal-status')).toHaveAttribute(
                'data-state',
                'cannot-connect',
            ),
        );
        // Reconnect affordance re-runs the flow.
        fireEvent.click(screen.getByTestId('terminal-reconnect'));
        await waitFor(() =>
            expect(screen.getByTestId('terminal-status')).toHaveAttribute(
                'data-state',
                'cannot-connect',
            ),
        );
    });

    it('viewers get the read-only badge', async () => {
        renderPane(okTokenFetch('viewer'));
        await waitFor(() =>
            expect(screen.getByTestId('terminal-readonly-badge')).toBeInTheDocument(),
        );
    });
});

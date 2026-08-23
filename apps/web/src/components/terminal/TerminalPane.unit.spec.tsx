import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, string>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));

import { TerminalPane } from './TerminalPane';
import type { TerminalRenderer } from './terminal-renderer';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

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

/** Transcript-page shape as the M9 replay endpoint returns it. */
type Page = {
    chunks: Array<{ seq: number; direction: 'out'; text: string; createdAt: string }>;
    lastSeq: number | null;
    hasMore: boolean;
    total: number;
};

const page = (chunks: Array<[number, string]>, hasMore = false): Page => ({
    chunks: chunks.map(([seq, text]) => ({
        seq,
        direction: 'out',
        text,
        createdAt: '2026-07-25T00:00:00.000Z',
    })),
    lastSeq: chunks.length ? chunks[chunks.length - 1][0] : null,
    hasMore,
    total: chunks.length,
});

/**
 * Routes the attach-token POST and the transcript GET separately so a
 * test can script the persisted history the pane rehydrates from.
 */
function transcriptFetch(pages: Page[], role = 'driver') {
    const transcriptCalls: string[] = [];
    let next = 0;
    const impl = vi.fn(async (url: string, init?: { method?: string }) => {
        if (String(url).includes('/terminal/transcript')) {
            transcriptCalls.push(String(url));
            const body = pages[next] ?? page([]);
            next += 1;
            return new Response(JSON.stringify(body), { status: 200 });
        }
        void init;
        return new Response(
            JSON.stringify({ token: 'tok', wsUrl: 'ws://x/ws/terminal/r', role, expiresInSec: 60 }),
            { status: 200 },
        );
    });
    return { impl: impl as unknown as typeof fetch, transcriptCalls };
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

    it('stamps the default transcript and attach transport from the visible Organization route', async () => {
        window.history.replaceState({}, '', '/org/ever/agents/agent-1');
        const fetchMock = vi.fn(
            async (input: RequestInfo | URL, _init?: RequestInit) =>
                new Response(
                    String(input).includes('/attach-token')
                        ? JSON.stringify({
                              token: 'tok',
                              wsUrl: 'ws://x/ws/terminal/r',
                              role: 'driver',
                              expiresInSec: 60,
                          })
                        : JSON.stringify({ chunks: [], lastSeq: null, hasMore: false, total: 0 }),
                    { status: 200 },
                ),
        );
        vi.stubGlobal('fetch', fetchMock);

        render(
            <TerminalPane
                agentId={AGENT}
                runId={RUN}
                createRenderer={async () => makeFakeRenderer()}
                attachDeps={{ webSocketImpl: ScriptedSocket as unknown as typeof WebSocket }}
            />,
        );

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        for (const call of fetchMock.mock.calls) {
            const init = call[1] as RequestInit;
            expect(new Headers(init.headers).get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:ever');
        }
        window.history.replaceState({}, '', '/');
        vi.unstubAllGlobals();
    });

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

    /**
     * Streaming-terminal M9 / founder decision D1 — the pane rehydrates
     * scrollback from the SERVER-SIDE transcript on attach. Before this,
     * the relay's in-memory scrollback was the only history and closing
     * the tab lost the session outright.
     */
    describe('transcript rehydration (M9)', () => {
        it('replays persisted history into the renderer before the live tail', async () => {
            const { impl, transcriptCalls } = transcriptFetch([
                page([
                    [0, '$ pnpm build\n'],
                    [1, '✔ done\n'],
                ]),
            ]);
            const renderer = renderPane(impl);

            await waitFor(() =>
                expect(screen.getByTestId('terminal-status')).toHaveAttribute(
                    'data-state',
                    'attached',
                ),
            );
            expect(transcriptCalls[0]).toContain('/terminal/transcript?fromSeq=0');
            expect(renderer.written.join('')).toBe('$ pnpm build\n✔ done\n');
        });

        it('DROPS relay-replayed frames it already rehydrated (no double-print)', async () => {
            const { impl } = transcriptFetch([page([[0, 'hello\n']])]);
            const renderer = renderPane(impl);

            await waitFor(() => expect(ScriptedSocket.instances).toHaveLength(1));
            const socket = ScriptedSocket.instances[0];
            // The relay replays its own scrollback on attach — seq 0 is
            // already on screen from the transcript.
            socket.emit({ kind: 'stdout', seq: 0, data: btoa('hello\n') });
            socket.emit({ kind: 'stdout', seq: 1, data: btoa('world\n') });

            await waitFor(() => expect(renderer.written.join('')).toContain('world'));
            expect(renderer.written.join('')).toBe('hello\nworld\n');
        });

        it('pages through a multi-page transcript using lastSeq + 1', async () => {
            const { impl, transcriptCalls } = transcriptFetch([
                page([[0, 'a']], true),
                page([[1, 'b']], true),
                page([], false),
            ]);
            const renderer = renderPane(impl);

            await waitFor(() =>
                expect(screen.getByTestId('terminal-status')).toHaveAttribute(
                    'data-state',
                    'attached',
                ),
            );
            expect(transcriptCalls).toHaveLength(3);
            expect(transcriptCalls[1]).toContain('fromSeq=1');
            expect(transcriptCalls[2]).toContain('fromSeq=2');
            expect(renderer.written.join('')).toBe('ab');
        });

        it('still attaches when no transcript exists (empty page)', async () => {
            const { impl } = transcriptFetch([page([])]);
            const renderer = renderPane(impl);

            await waitFor(() =>
                expect(screen.getByTestId('terminal-status')).toHaveAttribute(
                    'data-state',
                    'attached',
                ),
            );
            expect(renderer.written).toHaveLength(0);
            ScriptedSocket.instances[0].emit({ kind: 'stdout', seq: 0, data: btoa('live\n') });
            await waitFor(() => expect(renderer.written.join('')).toContain('live'));
        });

        it('attaches normally when the replay endpoint is unavailable (older API)', async () => {
            const impl = vi.fn(async (url: string) => {
                if (String(url).includes('/terminal/transcript')) {
                    return new Response('Not Found', { status: 404 });
                }
                return new Response(
                    JSON.stringify({
                        token: 'tok',
                        wsUrl: 'ws://x/ws/terminal/r',
                        role: 'driver',
                        expiresInSec: 60,
                    }),
                    { status: 200 },
                );
            }) as unknown as typeof fetch;
            const renderer = renderPane(impl);

            await waitFor(() =>
                expect(screen.getByTestId('terminal-status')).toHaveAttribute(
                    'data-state',
                    'attached',
                ),
            );
            // No history, and the seq gate never blocks the live tail.
            ScriptedSocket.instances[0].emit({ kind: 'stdout', seq: 0, data: btoa('live\n') });
            await waitFor(() => expect(renderer.written.join('')).toContain('live'));
        });
    });
});

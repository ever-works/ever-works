import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useComputerAttach, type ComputerAttachTarget } from './use-computer-attach';

const AGENT = '11111111-2222-4333-8444-555555555555';
const NODE = '22222222-2222-4333-8444-555555555555';
const SESSION = '33333333-2222-4333-8444-555555555555';
const SESSION_URL = `/api/agents/${AGENT}/computer/sessions/${SESSION}`;

/** A WebSocket double the test drives by hand. */
class FakeSocket {
    static last: FakeSocket | null = null;
    static throwOnConstruct = false;
    readonly OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
        if (FakeSocket.throwOnConstruct) throw new Error('blocked');
        FakeSocket.last = this;
    }
    send(data: string) {
        this.sent.push(data);
    }
    close() {
        this.closed = true;
        this.readyState = 3;
    }
    emit(frame: unknown) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

type Route = (url: string, init?: RequestInit) => Promise<Response> | Response;

/** A BFF double: opens SESSION, mints a token (or what `attachToken` answers), records every call. */
function bff(options: { open?: Route; attachToken?: Route } = {}) {
    const calls: Array<{ url: string; method: string; keepalive?: boolean }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({
            url,
            method: init.method ?? 'GET',
            ...(init.keepalive ? { keepalive: true } : {}),
        });
        if (url.endsWith('/computer/sessions') && init.method === 'POST') {
            return options.open
                ? options.open(url, init)
                : jsonResponse(202, { sessionId: SESSION, status: 'requested' });
        }
        if (url.endsWith('/attach-token')) {
            return options.attachToken
                ? options.attachToken(url, init)
                : jsonResponse(200, { token: 'tok', wsUrl: `ws://api/ws/computer/${SESSION}` });
        }
        return jsonResponse(200, { ended: true });
    });
    const ends = () => calls.filter((call) => call.method === 'DELETE' && call.url === SESSION_URL);
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, ends };
}

function target(over: Partial<ComputerAttachTarget> = {}): ComputerAttachTarget {
    return {
        agentId: AGENT,
        nodeId: NODE,
        channel: 'screen',
        quality: 'sharp',
        enabled: true,
        ...over,
    };
}

function renderAttach(fetchImpl: typeof fetch, initial: ComputerAttachTarget = target()) {
    return renderHook(
        (props: ComputerAttachTarget) =>
            useComputerAttach(
                props,
                { onPicture: vi.fn(), onTerminal: vi.fn() },
                { fetchImpl, webSocketImpl: FakeSocket as unknown as typeof WebSocket },
            ),
        { initialProps: initial },
    );
}

beforeEach(() => {
    FakeSocket.last = null;
    FakeSocket.throwOnConstruct = false;
});

describe('useComputerAttach — a session it opened is never left holding a slot', () => {
    it('ends the session when the attach token cannot be minted', async () => {
        const server = bff({ attachToken: () => jsonResponse(503, { message: 'down' }) });
        const { result } = renderAttach(server.fetchImpl);
        await waitFor(() => expect(result.current.state).toBe('cannot-connect'));
        await waitFor(() => expect(server.ends()).toHaveLength(1));
        expect(server.ends()[0].keepalive).toBe(true);
        expect(FakeSocket.last).toBeNull();
    });

    it('ends the session when the attach token request fails outright', async () => {
        const server = bff({
            attachToken: () => {
                throw new TypeError('network');
            },
        });
        const { result } = renderAttach(server.fetchImpl);
        await waitFor(() => expect(result.current.state).toBe('cannot-connect'));
        await waitFor(() => expect(server.ends()).toHaveLength(1));
    });

    it('ends the session when the socket cannot be constructed', async () => {
        FakeSocket.throwOnConstruct = true;
        const server = bff();
        const { result } = renderAttach(server.fetchImpl);
        await waitFor(() => expect(result.current.state).toBe('cannot-connect'));
        await waitFor(() => expect(server.ends()).toHaveLength(1));
    });

    it('ends a session that finished opening after the view was abandoned', async () => {
        let answerOpen: (response: Response) => void = () => undefined;
        const server = bff({
            open: () =>
                new Promise<Response>((resolve) => {
                    answerOpen = resolve;
                }),
        });
        const { unmount } = renderAttach(server.fetchImpl);
        await waitFor(() => expect(server.calls).toHaveLength(1));
        unmount();
        await act(async () => answerOpen(jsonResponse(202, { sessionId: SESSION })));
        await waitFor(() => expect(server.ends()).toHaveLength(1));
        // It never went on to ask for a token for a view nobody is waiting on.
        expect(server.calls.some((call) => call.url.endsWith('/attach-token'))).toBe(false);
    });

    it('ends the session when the view is abandoned before the relay accepted it', async () => {
        const server = bff();
        const { rerender } = renderAttach(server.fetchImpl);
        await waitFor(() => expect(FakeSocket.last).not.toBeNull());
        act(() => FakeSocket.last?.onopen?.());
        rerender(target({ channel: 'terminal' }));
        await waitFor(() => expect(server.ends()).toHaveLength(1));
    });

    it('ends the session when the relay refuses the viewer before any frame', async () => {
        const server = bff();
        const { result } = renderAttach(server.fetchImpl);
        await waitFor(() => expect(FakeSocket.last).not.toBeNull());
        act(() => FakeSocket.last?.onclose?.({ code: 4001 }));
        expect(result.current.state).toBe('refused');
        await waitFor(() => expect(server.ends()).toHaveLength(1));
    });

    it('leaves an attached view to the platform’s last-viewer grace instead of ending it', async () => {
        const server = bff();
        const { unmount, result } = renderAttach(server.fetchImpl);
        await waitFor(() => expect(FakeSocket.last).not.toBeNull());
        const socket = FakeSocket.last as FakeSocket;
        act(() => {
            socket.onopen?.();
            socket.emit({
                kind: 'frame',
                seq: 1,
                keyframe: true,
                width: 800,
                height: 600,
                mime: 'image/jpeg',
                data: 'QUJD',
            });
        });
        expect(result.current.state).toBe('live');
        unmount();
        expect(socket.closed).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(server.ends()).toHaveLength(0);
    });

    it('ends a session once when the owner cancels it while it is still connecting', async () => {
        const server = bff();
        const { result, rerender } = renderAttach(server.fetchImpl);
        await waitFor(() => expect(result.current.sessionId).toBe(SESSION));
        act(() => result.current.endSession());
        rerender(target({ enabled: false }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(server.ends()).toHaveLength(1);
    });
});

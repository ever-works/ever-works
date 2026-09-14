import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ComputerNodeOption } from '@ever-works/contracts';
import { AgentComputerClient, type AgentComputerClientProps } from './AgentComputerClient';

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
        `${namespace.replace('dashboard.', '')}.${key}${values ? `:${Object.values(values).join(',')}` : ''}`,
}));
const refresh = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('@/components/ui/show-datetime', () => ({
    ShowDateTime: ({ value }: { value?: string | null }) => <span>{value}</span>,
}));

const AGENT = '11111111-2222-4333-8444-555555555555';
const SESSION = '33333333-2222-4333-8444-555555555555';

function node(over: Partial<ComputerNodeOption> = {}): ComputerNodeOption {
    return {
        id: '22222222-2222-4333-8444-555555555555',
        name: 'studio-imac',
        kind: 'desktop-node',
        status: 'online',
        platform: 'darwin/arm64',
        lastHeartbeatAt: new Date().toISOString(),
        servableChannels: ['screen', 'terminal'],
        channelReasons: {},
        watchable: true,
        unwatchableReason: null,
        boundToAgent: true,
        controlPolicy: 'owner',
        ...over,
    };
}

/** A WebSocket double the test drives by hand. */
class FakeSocket {
    static last: FakeSocket | null = null;
    readonly OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
        FakeSocket.last = this;
    }
    send(data: string) {
        this.sent.push(data);
    }
    close() {
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

function renderClient(props: Partial<AgentComputerClientProps>, fetchImpl?: typeof fetch) {
    return render(
        <AgentComputerClient
            agentId={AGENT}
            agentName="Ops"
            nodes={[node()]}
            initialNodeId={null}
            initialChannel={null}
            stop={null}
            brief={null}
            profile={null}
            attachDeps={{
                fetchImpl: fetchImpl ?? (vi.fn() as unknown as typeof fetch),
                webSocketImpl: FakeSocket as unknown as typeof WebSocket,
            }}
            stageSeams={{
                decodePicture: async () =>
                    ({ width: 800, height: 600 }) as unknown as HTMLImageElement,
                createRenderer: async () => ({
                    kind: 'dom',
                    mount: vi.fn(),
                    write: vi.fn(),
                    onData: vi.fn(),
                    onResize: vi.fn(),
                    fit: vi.fn(),
                    focus: vi.fn(),
                    clear: vi.fn(),
                    dispose: vi.fn(),
                }),
            }}
            {...props}
        />,
    );
}

beforeEach(() => {
    FakeSocket.last = null;
    refresh.mockReset();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
});

describe('AgentComputerClient — states shown instead of a picture (no view is opened)', () => {
    it('shows the empty state with the way to add a computer', () => {
        const fetchImpl = vi.fn();
        renderClient({ nodes: [] }, fetchImpl as unknown as typeof fetch);
        expect(screen.getByTestId('computer-empty')).toHaveTextContent('computer.empty.title:Ops');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('says the list could not be loaded rather than that there are no computers', () => {
        renderClient({ nodes: null });
        expect(screen.getByTestId('computer-nodes-unavailable')).toBeInTheDocument();
    });

    it('shows an offline computer with try-again, and a switched-off one with the command that turns it on', () => {
        const fetchImpl = vi.fn();
        const { unmount } = renderClient(
            {
                nodes: [
                    node({
                        status: 'offline',
                        watchable: false,
                        unwatchableReason: 'offline',
                        servableChannels: [],
                    }),
                ],
            },
            fetchImpl as unknown as typeof fetch,
        );
        expect(screen.getByTestId('computer-offline')).toHaveTextContent(
            'computer.offline.title:studio-imac',
        );
        unmount();

        renderClient(
            {
                nodes: [
                    node({
                        watchable: false,
                        unwatchableReason: 'not-attended',
                        servableChannels: [],
                    }),
                ],
            },
            fetchImpl as unknown as typeof fetch,
        );
        expect(screen.getByTestId('computer-not-attended')).toBeInTheDocument();
        expect(screen.getByTestId('computer-attend-command')).toHaveTextContent(
            'computer.notAttended.command',
        );
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('offers the terminal instead when the screen cannot be shown', () => {
        renderClient({
            nodes: [
                node({ servableChannels: ['terminal'], channelReasons: { screen: 'no-browser' } }),
            ],
            initialChannel: 'screen',
        });
        expect(screen.getByTestId('computer-cannot-show')).toHaveTextContent(
            'computer.cannotShow.noBrowserTitle:studio-imac',
        );
        expect(screen.getByText('computer.cannotShow.watchTerminalInstead')).toBeInTheDocument();
    });

    it('follows a refreshed computer list that no longer holds the chosen computer, instead of claiming there is none', () => {
        const offline = {
            status: 'offline' as const,
            watchable: false,
            unwatchableReason: 'offline' as const,
        };
        const gone = node({
            id: '66666666-2222-4333-8444-555555555555',
            name: 'old-laptop',
            ...offline,
        });
        const kept = node({
            name: 'studio-imac',
            boundToAgent: false,
            ...offline,
            servableChannels: [],
        });
        const props = (nodes: ComputerNodeOption[]) =>
            ({
                agentId: AGENT,
                agentName: 'Ops',
                nodes,
                initialNodeId: gone.id,
                initialChannel: null,
                stop: null,
                brief: null,
                profile: null,
                attachDeps: {
                    fetchImpl: vi.fn() as unknown as typeof fetch,
                    webSocketImpl: FakeSocket as unknown as typeof WebSocket,
                },
            }) satisfies AgentComputerClientProps;

        const { rerender } = render(<AgentComputerClient {...props([gone, kept])} />);
        expect(screen.getByTestId('computer-offline')).toHaveTextContent(
            'computer.offline.title:old-laptop',
        );

        // `router.refresh()` answered with a list the old computer is no longer in.
        rerender(<AgentComputerClient {...props([kept])} />);
        expect(screen.queryByTestId('computer-empty')).not.toBeInTheDocument();
        expect(screen.getByTestId('computer-offline')).toHaveTextContent(
            'computer.offline.title:studio-imac',
        );
    });

    it('shows the fleet stop instead of opening anything', () => {
        renderClient({
            stop: {
                stopped: true,
                reason: 'Maintenance',
                since: '2026-09-13T08:55:00Z',
                unverified: false,
            },
        });
        expect(screen.getByTestId('computer-stopped')).toHaveTextContent('Maintenance');
    });
});

describe('AgentComputerClient — a live view', () => {
    it('opens a view, authenticates in the first frame, and renders the strip, watermark, brief and status line', async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            if (url.endsWith('/computer/sessions'))
                return jsonResponse(202, { sessionId: SESSION, status: 'requested' });
            if (url.endsWith('/attach-token'))
                return jsonResponse(200, {
                    token: 'tok',
                    wsUrl: `ws://api/ws/computer/${SESSION}`,
                });
            return jsonResponse(202, {});
        });
        renderClient({}, fetchImpl as unknown as typeof fetch);

        expect(await screen.findByTestId('computer-connecting')).toBeInTheDocument();
        await waitFor(() => expect(FakeSocket.last).not.toBeNull());
        const socket = FakeSocket.last as FakeSocket;
        expect(socket.url).not.toContain('tok');
        act(() => socket.onopen?.());
        expect(JSON.parse(socket.sent[0])).toEqual({ kind: 'auth', token: 'tok' });

        const [, openInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(JSON.parse(String(openInit.body))).toEqual({
            nodeId: node().id,
            channels: ['screen'],
            quality: 'sharp',
        });

        act(() => {
            socket.emit({
                kind: 'stats',
                nodeLocalTime: '2026-09-13T09:41:07+03:00',
                quality: 'sharp',
                effectiveQuality: 'sharp',
                fps: 8,
                backlog: 0,
                bytesOut: 2048,
            });
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

        expect(await screen.findByTestId('computer-surface')).toBeInTheDocument();
        await waitFor(() =>
            expect(screen.queryByTestId('computer-connecting')).not.toBeInTheDocument(),
        );
        expect(screen.getByTestId('computer-live-badge')).toHaveTextContent('computer.liveBadge');
        expect(screen.getByTestId('computer-node-clock')).toHaveTextContent('09:41:07');
        expect(screen.getByTestId('computer-watermark')).toHaveTextContent(
            'computer.watermark:Ops,studio-imac',
        );
        expect(screen.getByTestId('computer-brief')).toHaveTextContent('computer.briefIdle');
        expect(screen.getByTestId('computer-status-line')).toHaveTextContent(
            'computer.modeWatching:Ops',
        );
        expect(
            screen.getByRole('region', {
                name: 'computer.a11y.stageLabelWatching:Ops,studio-imac',
            }),
        ).toBeInTheDocument();
        // Watching only: no take-over control on this surface.
        expect(screen.queryByText(/takeOver/i)).not.toBeInTheDocument();
    });

    it('shows the machine’s banner, then why the view ended', async () => {
        const fetchImpl = vi.fn(async (url: string) =>
            url.endsWith('/computer/sessions')
                ? jsonResponse(202, { sessionId: SESSION })
                : jsonResponse(200, { token: 'tok', wsUrl: 'ws://api/ws/computer/x' }),
        );
        renderClient({}, fetchImpl as unknown as typeof fetch);
        await waitFor(() => expect(FakeSocket.last).not.toBeNull());
        const socket = FakeSocket.last as FakeSocket;
        act(() => {
            socket.onopen?.();
            socket.emit({
                kind: 'error',
                message: 'The picture stopped updating, so the capture was restarted.',
            });
        });
        expect(await screen.findByTestId('computer-banners')).toHaveTextContent(
            'capture was restarted',
        );

        act(() => socket.emit({ kind: 'end', reason: 'node-unavailable' }));
        expect(await screen.findByTestId('computer-ended')).toHaveTextContent(
            'computer.ended.reasons.nodeUnavailable',
        );
    });

    it('treats a view nobody picked up as "live view did not reach the machine"', async () => {
        const fetchImpl = vi.fn(async (url: string) =>
            url.endsWith('/computer/sessions')
                ? jsonResponse(202, { sessionId: SESSION })
                : jsonResponse(200, { token: 'tok', wsUrl: 'ws://api/ws/computer/x' }),
        );
        renderClient({}, fetchImpl as unknown as typeof fetch);
        await waitFor(() => expect(FakeSocket.last).not.toBeNull());
        act(() => (FakeSocket.last as FakeSocket).emit({ kind: 'end', reason: 'abandoned' }));
        expect(await screen.findByTestId('computer-not-attended')).toHaveTextContent(
            'computer.notAttended.abandonedTitle:studio-imac',
        );
    });

    it('never marks a quiet terminal as stalled or stopped, while a quiet screen is', async () => {
        const fetchImpl = vi.fn(async (url: string) =>
            url.endsWith('/computer/sessions')
                ? jsonResponse(202, { sessionId: SESSION })
                : jsonResponse(200, { token: 'tok', wsUrl: 'ws://api/ws/computer/x' }),
        );
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const { unmount } = renderClient(
                { initialChannel: 'terminal' },
                fetchImpl as unknown as typeof fetch,
            );
            await waitFor(() => expect(FakeSocket.last).not.toBeNull());
            const terminal = FakeSocket.last as FakeSocket;
            act(() => {
                terminal.onopen?.();
                terminal.emit({
                    kind: 'terminal',
                    frame: { kind: 'stdout', seq: 0, data: 'JCA=' },
                });
            });
            expect(await screen.findByTestId('computer-terminal')).toBeInTheDocument();
            // A shell waiting at its prompt: fifty silent seconds.
            act(() => vi.advanceTimersByTime(50_000));
            expect(screen.queryByText('computer.stall.stopped')).not.toBeInTheDocument();
            expect(screen.queryByRole('alert')).not.toBeInTheDocument();
            unmount();

            renderClient({ initialChannel: 'screen' }, fetchImpl as unknown as typeof fetch);
            await waitFor(() => expect(FakeSocket.last).not.toBe(terminal));
            const screenSocket = FakeSocket.last as unknown as FakeSocket;
            act(() => {
                screenSocket.onopen?.();
                screenSocket.emit({
                    kind: 'frame',
                    seq: 1,
                    keyframe: true,
                    width: 800,
                    height: 600,
                    mime: 'image/jpeg',
                    data: 'QUJD',
                });
            });
            expect(await screen.findByTestId('computer-canvas')).toBeInTheDocument();
            act(() => vi.advanceTimersByTime(50_000));
            expect(screen.getByText('computer.stall.stopped')).toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });

    it('announces a stale picture once and politely, and interrupts only when the stream has stopped', async () => {
        const fetchImpl = vi.fn(async (url: string) =>
            url.endsWith('/computer/sessions')
                ? jsonResponse(202, { sessionId: SESSION })
                : jsonResponse(200, { token: 'tok', wsUrl: 'ws://api/ws/computer/x' }),
        );
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            renderClient({ initialChannel: 'screen' }, fetchImpl as unknown as typeof fetch);
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
            expect(await screen.findByTestId('computer-canvas')).toBeInTheDocument();

            // Stalled, then auto-refreshed: the banner shows, the status line says it, nothing interrupts.
            act(() => vi.advanceTimersByTime(10_000));
            expect(screen.getByTestId('computer-stall-banner')).toBeInTheDocument();
            expect(screen.getByTestId('computer-status-line')).toHaveTextContent(
                'computer.stall.staleNote',
            );
            expect(screen.queryByRole('alert')).not.toBeInTheDocument();
            act(() => vi.advanceTimersByTime(15_000));
            expect(screen.getByTestId('computer-stall-banner')).toBeInTheDocument();
            expect(screen.queryByRole('alert')).not.toBeInTheDocument();

            // Dead: the one assertive announcement, with Reconnect.
            act(() => vi.advanceTimersByTime(25_000));
            expect(screen.getByRole('alert')).toHaveTextContent('computer.stall.stopped');
        } finally {
            vi.useRealTimers();
        }
    });

    it('renders the over-limit refusal with its count, and never opens a socket', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse(429, {
                reason: 'node-session-cap',
                limit: 2,
                sessions: [{ sessionId: 'a', since: '09:02' }],
            }),
        );
        renderClient({}, fetchImpl as unknown as typeof fetch);
        expect(await screen.findByTestId('computer-over-limit')).toHaveTextContent(
            'computer.overLimit.title:studio-imac,2',
        );
        expect(FakeSocket.last).toBeNull();
    });
});

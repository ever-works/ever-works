import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComputerControlStateView, ComputerNodeOption } from '@ever-works/contracts';
import { AgentComputerClient } from './AgentComputerClient';

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
        `${namespace.replace('dashboard.', '')}.${key}${values ? `:${Object.values(values).join(',')}` : ''}`,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('@/components/ui/show-datetime', () => ({
    ShowDateTime: ({ value }: { value?: string | null }) => <span>{value}</span>,
}));

/**
 * The computer page once a person can take control. Pinned: Take over is
 * offered only when the platform confirms control for this view; only the
 * platform's answer puts the page in control (amber stage, YOU badge, the
 * "input is paused" sentence); the page then drives through a driving socket
 * and sends keys to the computer; Escape twice gives control back; a
 * refusal by policy disables the button with the reason; and a machine held
 * by another view offers Request control instead.
 */

const AGENT = '11111111-2222-4333-8444-555555555555';
const SESSION = '33333333-2222-4333-8444-555555555555';
const OTHER_VIEW = '44444444-2222-4333-8444-555555555555';
const CONTROL_URL = `/api/agents/${AGENT}/computer/sessions/${SESSION}/control`;

function node(): ComputerNodeOption {
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
    };
}

class FakeSocket {
    static all: FakeSocket[] = [];
    readonly OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
        FakeSocket.all.push(this);
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

function json(status: number, body: unknown): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function controlState(patch: Partial<ComputerControlStateView> = {}): ComputerControlStateView {
    return {
        nodeId: node().id,
        sessionId: SESSION,
        policy: 'owner',
        canControl: true,
        mode: 'watching',
        holder: null,
        request: null,
        lastRelease: null,
        serverTime: new Date().toISOString(),
        ...patch,
    };
}

function controllingState(): ComputerControlStateView {
    return controlState({
        mode: 'controlling',
        holder: {
            userId: 'u1',
            sessionId: SESSION,
            since: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            idleAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            extended: false,
            you: true,
            thisView: true,
        },
    });
}

/** The BFF as the page sees it, with a control state the test moves. */
function bff(initial: ComputerControlStateView) {
    let current = initial;
    /** What a control act (POST / DELETE on the control route) answers; polls never reach it. */
    let onAct: ((init: RequestInit) => Response) | null = null;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        if (url.endsWith('/computer/sessions')) return json(202, { sessionId: SESSION });
        if (url.endsWith('/attach-token')) {
            return json(200, {
                token: 'watch-tok',
                wsUrl: 'ws://api/ws/computer/x',
                role: 'viewer',
            });
        }
        if (url.endsWith('/attach-token?role=controller')) {
            return json(200, {
                token: 'drive-tok',
                wsUrl: 'ws://api/ws/computer/x',
                role: current.mode === 'controlling' ? 'driver' : 'viewer',
            });
        }
        if (url === CONTROL_URL && method === 'GET') return json(200, current);
        if (url === CONTROL_URL && onAct) return onAct(init);
        return json(404, {});
    });
    return {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        set: (next: ComputerControlStateView) => {
            current = next;
        },
        answerActs: (handler: (init: RequestInit) => Response) => {
            onAct = handler;
        },
        route: fetchImpl,
    };
}

async function renderLive(server: ReturnType<typeof bff>) {
    render(
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
                fetchImpl: server.fetchImpl,
                webSocketImpl: FakeSocket as unknown as typeof WebSocket,
            }}
            stageSeams={{
                decodePicture: async () =>
                    ({ width: 800, height: 600 }) as unknown as HTMLImageElement,
            }}
        />,
    );
    await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    const socket = FakeSocket.all[0];
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
    return socket;
}

beforeEach(() => {
    FakeSocket.all = [];
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
});

describe('AgentComputerClient — taking control', () => {
    it('takes over on the platform’s answer, drives through a driving socket, and gives back on Escape twice', async () => {
        const server = bff(controlState());
        const watching = await renderLive(server);

        const takeOver = await screen.findByTestId('computer-take-over');
        expect(takeOver).not.toBeDisabled();
        expect(screen.getByTestId('computer-status-line')).toHaveTextContent(
            'computer.modeWatching:Ops',
        );

        server.answerActs((init) => {
            expect(init.method).toBe('POST');
            server.set(controllingState());
            return json(200, controllingState());
        });
        fireEvent.click(takeOver);

        await waitFor(() =>
            expect(screen.getByTestId('computer-status-line')).toHaveTextContent(
                'computer.modeControlling:Ops',
            ),
        );
        expect(screen.getByTestId('computer-you-badge')).toHaveTextContent(
            'computer.control.youBadge',
        );
        expect(screen.getByTestId('computer-stage')).toHaveAttribute('data-controlling', 'true');
        expect(
            screen.getByRole('region', {
                name: 'computer.a11y.stageLabelControlling:Ops,studio-imac',
            }),
        ).toBeInTheDocument();
        expect(screen.getByTestId('computer-give-back')).toBeInTheDocument();

        // The driving socket takes over only once it is open.
        await waitFor(() => expect(FakeSocket.all).toHaveLength(2));
        const driving = FakeSocket.all[1];
        act(() => driving.onopen?.());
        expect(JSON.parse(driving.sent[0])).toEqual({ kind: 'auth', token: 'drive-tok' });
        expect(watching.closed).toBe(true);

        const stage = screen.getByTestId('computer-stage');
        fireEvent.keyDown(stage, { key: 'x', code: 'KeyX' });
        expect(JSON.parse(driving.sent.at(-1) as string)).toEqual({
            kind: 'key',
            action: 'down',
            key: 'x',
            code: 'KeyX',
            modifiers: 0,
        });
        // A clipboard shortcut is never sent.
        const before = driving.sent.length;
        fireEvent.keyDown(stage, { key: 'v', code: 'KeyV', ctrlKey: true });
        expect(driving.sent).toHaveLength(before);

        server.answerActs((init) => {
            expect(init.method).toBe('DELETE');
            server.set(
                controlState({
                    lastRelease: { reason: 'given-back', at: new Date().toISOString() },
                }),
            );
            return json(204, null);
        });
        fireEvent.keyDown(stage, { key: 'Escape', code: 'Escape' });
        fireEvent.keyDown(stage, { key: 'Escape', code: 'Escape' });

        await waitFor(() =>
            expect(screen.getByTestId('computer-status-line')).toHaveTextContent(
                'computer.modeWatching:Ops',
            ),
        );
        expect(screen.queryByTestId('computer-you-badge')).not.toBeInTheDocument();
    });

    it('disables Take over with the reason when the policy leaves this person out', async () => {
        const server = bff(controlState({ canControl: false }));
        await renderLive(server);
        const takeOver = await screen.findByTestId('computer-take-over');
        expect(takeOver).toBeDisabled();
        expect(takeOver).toHaveAccessibleDescription('computer.control.deniedTooltip');
    });

    it('offers Request control when another view already has control', async () => {
        const held = controlState({
            holder: {
                userId: 'u1',
                sessionId: OTHER_VIEW,
                since: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
                idleAt: new Date(Date.now() + 10 * 60_000).toISOString(),
                extended: false,
                you: true,
                thisView: false,
            },
        });
        const server = bff(held);
        await renderLive(server);

        server.answerActs(() => json(409, { reason: 'held', state: held }));
        fireEvent.click(await screen.findByTestId('computer-take-over'));

        const prompt = await screen.findByTestId('computer-held-elsewhere');
        expect(prompt).toHaveTextContent('computer.control.heldByYou');
        expect(screen.getByTestId('computer-status-line')).toHaveTextContent(
            'computer.modeWatching:Ops',
        );

        server.answerActs((init) => {
            expect(JSON.parse(String(init.body))).toEqual({ request: true });
            return json(200, {
                ...held,
                request: {
                    requestId: SESSION,
                    userId: 'u1',
                    sessionId: SESSION,
                    requestedAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    you: true,
                },
            });
        });
        fireEvent.click(screen.getByRole('button', { name: 'computer.control.requestControl' }));
        expect(await screen.findByTestId('computer-request-waiting')).toBeInTheDocument();
    });

    it('shows no take-over control at all when the platform does not confirm control for this view', async () => {
        const server = bff(controlState());
        server.route.mockImplementation(async (url: string) => {
            if (url.endsWith('/computer/sessions')) return json(202, { sessionId: SESSION });
            if (url.endsWith('/attach-token')) {
                return json(200, { token: 'watch-tok', wsUrl: 'ws://api/ws/computer/x' });
            }
            return json(503, { reason: 'control-unavailable' });
        });
        await renderLive(server);
        await waitFor(() =>
            expect(server.route.mock.calls.some(([url]) => url === CONTROL_URL)).toBe(true),
        );
        expect(screen.queryByTestId('computer-take-over')).not.toBeInTheDocument();
    });
});

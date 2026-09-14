import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import type { HttpAdapterHost } from '@nestjs/core';
import { TerminalAttachService } from '../terminal/terminal-attach.service';
import { TerminalRelayRegistry } from '../terminal/terminal-relay.registry';
import { TerminalWsService } from '../terminal/terminal-ws.service';
import { ComputerAttachService } from './computer-attach.service';
import { ComputerRelayRegistry } from './computer-relay.registry';
import { ComputerWsService } from './computer-ws.service';

/**
 * The live-view gateway over real sockets, mounted on the SAME HTTP server
 * as the terminal gateway — which is how it runs in the API process. Pinned:
 * the token rides the first frame and never the URL, a watching socket can
 * never inject input, the two gateways never take each other's sockets, and
 * a view nobody is watching ends on its own.
 */

const SESSION = '6d000000-0000-4000-8000-000000000001';
const RUN = '7e000000-0000-4000-8000-000000000002';

describe('ComputerWsService (integration)', () => {
    let server: Server;
    let gateway: ComputerWsService;
    let terminalGateway: TerminalWsService;
    let relay: ComputerRelayRegistry;
    let attach: ComputerAttachService;
    let signer: TerminalAttachService;
    let sessions: { limits: jest.Mock; closeById: jest.Mock };
    let baseUrl: string;
    const savedSecret = process.env.TERMINAL_ATTACH_SECRET;

    beforeAll(async () => {
        process.env.TERMINAL_ATTACH_SECRET = 'computer-ws-integration-secret';
        server = createServer((_, res) => {
            res.statusCode = 404;
            res.end();
        });
        const adapterHost = {
            httpAdapter: { getHttpServer: () => server },
        } as unknown as HttpAdapterHost;
        signer = new TerminalAttachService();
        attach = new ComputerAttachService(signer);
        relay = new ComputerRelayRegistry();
        sessions = {
            limits: jest.fn(() => ({ lastViewerGraceMs: 150 })),
            closeById: jest.fn(async () => true),
        };
        terminalGateway = new TerminalWsService(adapterHost, signer, new TerminalRelayRegistry());
        terminalGateway.onApplicationBootstrap();
        gateway = new ComputerWsService(adapterHost, attach, relay, sessions as never);
        gateway.onApplicationBootstrap();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        gateway.onApplicationShutdown();
        terminalGateway.onApplicationShutdown();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (savedSecret === undefined) delete process.env.TERMINAL_ATTACH_SECRET;
        else process.env.TERMINAL_ATTACH_SECRET = savedSecret;
    });

    const connect = (path: string) =>
        new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(`${baseUrl}${path}`);
            ws.once('open', () => resolve(ws));
            ws.once('error', reject);
        });
    const closed = (ws: WebSocket) =>
        new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    const nextMessage = (ws: WebSocket) =>
        new Promise<Record<string, unknown>>((resolve) =>
            ws.once('message', (data) => resolve(JSON.parse(data.toString()))),
        );
    const tick = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

    it('refuses an upgrade that carries a query string', async () => {
        const token = attach.mint({ userId: 'u1', sessionId: SESSION, role: 'viewer' }).token;
        await expect(connect(`/ws/computer/${SESSION}?token=${token}`)).rejects.toBeTruthy();
    });

    describe('with the fleet switched off (FLEET_ENABLED=false)', () => {
        const savedFlag = process.env.FLEET_ENABLED;
        afterEach(() => {
            if (savedFlag === undefined) delete process.env.FLEET_ENABLED;
            else process.env.FLEET_ENABLED = savedFlag;
        });

        it('refuses the upgrade before any token is presented', async () => {
            process.env.FLEET_ENABLED = 'false';
            await expect(connect(`/ws/computer/${SESSION}`)).rejects.toBeTruthy();
        });

        it('lets no still-valid token authenticate a socket opened before the switch', async () => {
            const view = 'ab000000-0000-4000-8000-000000000005';
            const ws = await connect(`/ws/computer/${view}`);
            const closing = closed(ws);
            process.env.FLEET_ENABLED = 'false';
            ws.send(
                JSON.stringify({
                    kind: 'auth',
                    token: attach.mint({ userId: 'u1', sessionId: view, role: 'viewer' }).token,
                }),
            );
            expect(await closing).toBe(4001);
            expect(relay.getStatus(view).clientCount).toBe(0);
        });

        it('takes live views back the moment the flag is on again, with no restart', async () => {
            process.env.FLEET_ENABLED = 'false';
            await expect(connect(`/ws/computer/${SESSION}`)).rejects.toBeTruthy();
            process.env.FLEET_ENABLED = 'true';
            const ws = await connect(`/ws/computer/${SESSION}`);
            expect(ws.readyState).toBe(WebSocket.OPEN);
            ws.close();
        });
    });

    it('refuses a malformed live-view path', async () => {
        await expect(connect('/ws/computer/not-a-uuid')).rejects.toBeTruthy();
    });

    it('closes 4001 when the first frame is not a valid live-view token', async () => {
        const ws = await connect(`/ws/computer/${SESSION}`);
        const closing = closed(ws);
        ws.send(JSON.stringify({ kind: 'refresh' }));
        expect(await closing).toBe(4001);
    });

    it('closes 4001 for a terminal token, and for a token minted for another view', async () => {
        const terminalToken = signer.mint({ userId: 'u1', runId: SESSION, role: 'viewer' }).token;
        const first = await connect(`/ws/computer/${SESSION}`);
        const firstClosed = closed(first);
        first.send(JSON.stringify({ kind: 'auth', token: terminalToken }));
        expect(await firstClosed).toBe(4001);

        const otherView = attach.mint({ userId: 'u1', sessionId: RUN, role: 'viewer' }).token;
        const second = await connect(`/ws/computer/${SESSION}`);
        const secondClosed = closed(second);
        second.send(JSON.stringify({ kind: 'auth', token: otherView }));
        expect(await secondClosed).toBe(4001);
    });

    it('never lets a live-view token open a terminal socket', async () => {
        const token = attach.mint({ userId: 'u1', sessionId: RUN, role: 'viewer' }).token;
        const ws = await connect(`/ws/terminal/${RUN}`);
        const closing = closed(ws);
        ws.send(JSON.stringify({ kind: 'auth', token }));
        expect(await closing).toBe(4001);
    });

    it('replays the retained picture on attach, and answers a watching socket’s input with an error the machine never sees', async () => {
        const view = '8f000000-0000-4000-8000-000000000003';
        relay.publish(view, {
            kind: 'frame',
            seq: 0,
            keyframe: true,
            width: 2,
            height: 2,
            mime: 'image/png',
            data: 'aGk=',
        });

        const node = await connect(`/ws/computer/${view}`);
        node.send(
            JSON.stringify({
                kind: 'auth',
                token: attach.mint({ userId: 'node:n1', sessionId: view, role: 'worker' }).token,
            }),
        );
        await tick();
        const nodeGot: unknown[] = [];
        node.on('message', (data) => nodeGot.push(JSON.parse(data.toString())));

        const viewer = await connect(`/ws/computer/${view}`);
        const replay = nextMessage(viewer);
        viewer.send(
            JSON.stringify({
                kind: 'auth',
                token: attach.mint({ userId: 'u1', sessionId: view, role: 'viewer' }).token,
            }),
        );
        expect(await replay).toMatchObject({ kind: 'frame', seq: 0 });

        const refusal = nextMessage(viewer);
        viewer.send(
            JSON.stringify({ kind: 'pointer', action: 'down', x: 1, y: 1, button: 'left' }),
        );
        expect((await refusal).kind).toBe('error');

        viewer.send(JSON.stringify({ kind: 'refresh' }));
        await tick(150);
        expect(nodeGot).toEqual([{ kind: 'refresh' }]);

        viewer.close();
        node.close();
    });

    it('ends a view after the grace once its last viewer leaves, and not while someone is back', async () => {
        const view = '9a000000-0000-4000-8000-000000000004';
        const token = () => attach.mint({ userId: 'u1', sessionId: view, role: 'viewer' }).token;

        const first = await connect(`/ws/computer/${view}`);
        first.send(JSON.stringify({ kind: 'auth', token: token() }));
        await tick();
        first.close();
        await tick(50);
        const second = await connect(`/ws/computer/${view}`);
        second.send(JSON.stringify({ kind: 'auth', token: token() }));
        await tick(250);
        expect(sessions.closeById).not.toHaveBeenCalledWith(view, 'no-viewer');

        second.close();
        await tick(300);
        expect(sessions.closeById).toHaveBeenCalledWith(view, 'no-viewer');
    });

    it('leaves terminal sockets working on the shared server', async () => {
        const terminalToken = signer.mint({ userId: 'u1', runId: RUN, role: 'driver' }).token;
        const ws = await connect(`/ws/terminal/${RUN}`);
        ws.send(JSON.stringify({ kind: 'auth', token: terminalToken }));
        await tick(150);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
    });
});

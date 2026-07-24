import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import type { HttpAdapterHost } from '@nestjs/core';
import { TerminalWsService } from '../terminal-ws.service';
import { TerminalAttachService } from '../terminal-attach.service';
import { TerminalRelayRegistry } from '../terminal-relay.registry';

const RUN = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';

/**
 * Real-socket integration: an actual `http.Server` + `ws` clients
 * against the mounted gateway — the full handshake/auth/replay/inbound
 * path with zero mocks below the attach service's env secret.
 */
describe('TerminalWsService (integration)', () => {
    let server: Server;
    let service: TerminalWsService;
    let registry: TerminalRelayRegistry;
    let attach: TerminalAttachService;
    let baseUrl: string;
    const savedSecret = process.env.TERMINAL_ATTACH_SECRET;

    beforeAll(async () => {
        process.env.TERMINAL_ATTACH_SECRET = 'integration-test-secret-value';
        server = createServer((_, res) => {
            res.statusCode = 404;
            res.end();
        });
        registry = new TerminalRelayRegistry();
        attach = new TerminalAttachService();
        const adapterHost = {
            httpAdapter: { getHttpServer: () => server },
        } as unknown as HttpAdapterHost;
        service = new TerminalWsService(adapterHost, attach, registry);
        service.onApplicationBootstrap();

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as AddressInfo;
        baseUrl = `ws://127.0.0.1:${port}`;
    });

    afterAll(async () => {
        service.onApplicationShutdown();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (savedSecret === undefined) delete process.env.TERMINAL_ATTACH_SECRET;
        else process.env.TERMINAL_ATTACH_SECRET = savedSecret;
    });

    function connect(runId: string): Promise<WebSocket> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`${baseUrl}/ws/terminal/${runId}`);
            ws.once('open', () => resolve(ws));
            ws.once('error', reject);
        });
    }

    function nextMessage(ws: WebSocket): Promise<string> {
        return new Promise((resolve) => ws.once('message', (d) => resolve(d.toString())));
    }

    function closed(ws: WebSocket): Promise<number> {
        return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
    }

    it('closes 4001 when the first message is not a valid auth frame', async () => {
        const ws = await connect(RUN);
        const closing = closed(ws);
        ws.send(JSON.stringify({ kind: 'stdin', data: 'aGk=' }));
        expect(await closing).toBe(4001);
    });

    it('closes 4001 on an invalid or cross-run token', async () => {
        const otherRun = '3a000000-0000-4000-8000-000000000001';
        const { token } = attach.mint({ userId: 'u1', runId: otherRun, role: 'driver' });
        const ws = await connect(RUN);
        const closing = closed(ws);
        ws.send(JSON.stringify({ kind: 'auth', token })); // token for a DIFFERENT run
        expect(await closing).toBe(4001);
    });

    it('authenticated attach replays history then receives the live tail', async () => {
        registry.publish(RUN, { kind: 'error', message: 'starting…' });
        registry.publish(RUN, { kind: 'stdout', seq: 0, data: 'aGk=' });

        const { token } = attach.mint({ userId: 'u1', runId: RUN, role: 'driver' });
        const ws = await connect(RUN);
        const received: string[] = [];
        ws.on('message', (d) => received.push(d.toString()));
        ws.send(JSON.stringify({ kind: 'auth', token }));

        // Replay (banner + stdout) arrives, then a live frame.
        await new Promise((r) => setTimeout(r, 200));
        registry.publish(RUN, { kind: 'stdout', seq: 1, data: 'bGl2ZQ==' });
        await new Promise((r) => setTimeout(r, 200));

        const kinds = received.map((m) => JSON.parse(m).kind);
        expect(kinds).toEqual(['error', 'stdout', 'stdout']);
        ws.close();
    });

    it('driver stdin flows through the relay to a worker socket on the same run', async () => {
        const SESSION = '4b000000-0000-4000-8000-000000000002';
        const driverToken = attach.mint({ userId: 'u1', runId: SESSION, role: 'driver' }).token;
        const workerToken = attach.mint({ userId: 'worker', runId: SESSION, role: 'worker' }).token;

        const worker = await connect(SESSION);
        worker.send(JSON.stringify({ kind: 'auth', token: workerToken }));
        await new Promise((r) => setTimeout(r, 100));

        const driver = await connect(SESSION);
        driver.send(JSON.stringify({ kind: 'auth', token: driverToken }));
        await new Promise((r) => setTimeout(r, 100));

        const workerInbox = nextMessage(worker);
        driver.send(JSON.stringify({ kind: 'stdin', data: 'bHM=' }));

        const frame = JSON.parse(await workerInbox);
        expect(frame).toEqual({ kind: 'stdin', data: 'bHM=' });
        worker.close();
        driver.close();
    });

    it('viewer stdin is refused with an error frame answered to the viewer only', async () => {
        const SESSION = '5c000000-0000-4000-8000-000000000003';
        const viewerToken = attach.mint({ userId: 'u2', runId: SESSION, role: 'viewer' }).token;
        const workerToken = attach.mint({ userId: 'worker', runId: SESSION, role: 'worker' }).token;

        const worker = await connect(SESSION);
        worker.send(JSON.stringify({ kind: 'auth', token: workerToken }));
        const viewer = await connect(SESSION);
        viewer.send(JSON.stringify({ kind: 'auth', token: viewerToken }));
        await new Promise((r) => setTimeout(r, 100));

        const workerGot: string[] = [];
        worker.on('message', (d) => workerGot.push(d.toString()));
        const viewerInbox = nextMessage(viewer);
        viewer.send(JSON.stringify({ kind: 'stdin', data: 'cm0gLXJm' }));

        const refusal = JSON.parse(await viewerInbox);
        expect(refusal.kind).toBe('error');
        await new Promise((r) => setTimeout(r, 150));
        expect(workerGot).toHaveLength(0);
        worker.close();
        viewer.close();
    });

    it('destroys sockets for malformed upgrade paths (shape gate before any registry touch)', async () => {
        await expect(
            new Promise((resolve, reject) => {
                const ws = new WebSocket(`${baseUrl}/ws/terminal/not-a-uuid`);
                ws.once('open', () => resolve('open'));
                ws.once('error', reject);
            }),
        ).rejects.toBeTruthy();
    });
});

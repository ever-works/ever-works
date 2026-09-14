import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import type { HttpAdapterHost } from '@nestjs/core';
import { TerminalAttachService } from '../terminal/terminal-attach.service';
import { ComputerAttachService } from './computer-attach.service';
import { ComputerRelayRegistry } from './computer-relay.registry';
import { ComputerWsService } from './computer-ws.service';

/**
 * The live-view gateway once a person can take control, over real sockets.
 * Pinned:
 *
 *  - input from a driving socket reaches the machine only while its view
 *    holds control, and a hold granted elsewhere starts working without a
 *    reconnect (the gateway re-reads it on refused input);
 *  - accepted input pushes the idle deadline through the arbiter;
 *  - when the holding view's last driving socket goes away, control is given
 *    back after the disconnect grace — and not if a driving socket returns.
 */

describe('ComputerWsService — taking control (integration)', () => {
    let server: Server;
    let gateway: ComputerWsService;
    let relay: ComputerRelayRegistry;
    let attach: ComputerAttachService;
    let control: {
        limits: jest.Mock;
        holdOf: jest.Mock;
        recordInput: jest.Mock;
        acknowledge: jest.Mock;
        releaseForSession: jest.Mock;
    };
    let baseUrl: string;
    const savedSecret = process.env.TERMINAL_ATTACH_SECRET;

    beforeAll(async () => {
        process.env.TERMINAL_ATTACH_SECRET = 'computer-ws-control-secret';
        server = createServer((_, res) => {
            res.statusCode = 404;
            res.end();
        });
        const adapterHost = {
            httpAdapter: { getHttpServer: () => server },
        } as unknown as HttpAdapterHost;
        attach = new ComputerAttachService(new TerminalAttachService());
        relay = new ComputerRelayRegistry(undefined, true);
        control = {
            limits: jest.fn(() => ({ disconnectMs: 150 })),
            holdOf: jest.fn(async () => ({ held: false, untilMs: null })),
            recordInput: jest.fn(async () => ({ held: true, untilMs: Date.now() + 60_000 })),
            acknowledge: jest.fn(async () => undefined),
            releaseForSession: jest.fn(async () => true),
        };
        const sessions = {
            limits: jest.fn(() => ({ lastViewerGraceMs: 60_000 })),
            closeById: jest.fn(async () => true),
        };
        gateway = new ComputerWsService(
            adapterHost,
            attach,
            relay,
            sessions as never,
            control as never,
        );
        gateway.onApplicationBootstrap();
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        gateway.onApplicationShutdown();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (savedSecret === undefined) delete process.env.TERMINAL_ATTACH_SECRET;
        else process.env.TERMINAL_ATTACH_SECRET = savedSecret;
    });

    beforeEach(() => {
        for (const mock of Object.values(control)) mock.mockClear();
    });

    const connect = (path: string) =>
        new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(`${baseUrl}${path}`);
            ws.once('open', () => resolve(ws));
            ws.once('error', reject);
        });
    const tick = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
    const auth = (ws: WebSocket, view: string, role: 'viewer' | 'driver' | 'worker') =>
        ws.send(
            JSON.stringify({
                kind: 'auth',
                token: attach.mint({ userId: 'u1', sessionId: view, role }).token,
            }),
        );
    const pointer = JSON.stringify({ kind: 'pointer', action: 'move', x: 5, y: 6, button: null });

    it('forwards a driving socket’s input only once the arbiter says its view holds control', async () => {
        const view = 'c1000000-0000-4000-8000-000000000001';
        const node = await connect(`/ws/computer/${view}`);
        auth(node, view, 'worker');
        await tick();
        const nodeGot: Array<Record<string, unknown>> = [];
        node.on('message', (data) => nodeGot.push(JSON.parse(data.toString())));

        const driver = await connect(`/ws/computer/${view}`);
        auth(driver, view, 'driver');
        await tick(150);
        // Not held: refused, and the gateway re-reads the hold.
        driver.send(pointer);
        await tick(150);
        expect(nodeGot).toEqual([]);
        expect(control.holdOf).toHaveBeenCalledWith(view);

        // Control granted (as another replica might have): the next refused
        // input's refresh picks it up, and input flows without a reconnect.
        control.holdOf.mockResolvedValue({ held: true, untilMs: Date.now() + 60_000 });
        await tick(1100);
        driver.send(pointer);
        await tick(150);
        expect(nodeGot).toContainEqual({ kind: 'mode', mode: 'controlling' });
        driver.send(pointer);
        await tick(150);
        expect(nodeGot.filter((frame) => frame.kind === 'pointer')).toHaveLength(1);
        expect(control.recordInput).toHaveBeenCalledWith(view);

        driver.close();
        node.close();
        // Its disconnect grace runs out here, before the next case starts.
        await tick(300);
        control.holdOf.mockResolvedValue({ held: false, untilMs: null });
    });

    it('gives control back after the disconnect grace once the last driving socket leaves', async () => {
        const view = 'c2000000-0000-4000-8000-000000000002';
        relay.applyControl(view, { held: true, untilMs: Date.now() + 60_000 });
        control.holdOf.mockResolvedValue({ held: true, untilMs: Date.now() + 60_000 });

        const driver = await connect(`/ws/computer/${view}`);
        auth(driver, view, 'driver');
        await tick();
        driver.close();
        await tick(60);
        expect(control.releaseForSession).not.toHaveBeenCalledWith(view, expect.anything());
        await tick(200);
        expect(control.releaseForSession).toHaveBeenCalledWith(view, 'disconnected');
        control.holdOf.mockResolvedValue({ held: false, untilMs: null });
    });

    it('does not give control back when a driving socket returns within the grace', async () => {
        const view = 'c3000000-0000-4000-8000-000000000003';
        relay.applyControl(view, { held: true, untilMs: Date.now() + 60_000 });
        control.holdOf.mockResolvedValue({ held: true, untilMs: Date.now() + 60_000 });

        const first = await connect(`/ws/computer/${view}`);
        auth(first, view, 'driver');
        await tick();
        first.close();
        await tick(40);
        const second = await connect(`/ws/computer/${view}`);
        auth(second, view, 'driver');
        await tick(300);
        expect(control.releaseForSession).not.toHaveBeenCalledWith(view, expect.anything());

        second.close();
        // Its own disconnect grace runs out here, before the next case starts.
        await tick(300);
        expect(control.releaseForSession).toHaveBeenCalledWith(view, 'disconnected');
        control.holdOf.mockResolvedValue({ held: false, untilMs: null });
    });

    it('never starts a disconnect release for a watching socket', async () => {
        const view = 'c4000000-0000-4000-8000-000000000004';
        relay.applyControl(view, { held: true, untilMs: Date.now() + 60_000 });
        const viewer = await connect(`/ws/computer/${view}`);
        auth(viewer, view, 'viewer');
        await tick();
        viewer.close();
        await tick(300);
        expect(control.releaseForSession).not.toHaveBeenCalledWith(view, expect.anything());
    });
});

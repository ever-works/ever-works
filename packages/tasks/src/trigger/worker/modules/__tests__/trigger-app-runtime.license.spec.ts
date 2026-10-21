import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import superjson from 'superjson';
import { APP_LICENSE_SERVICE, AppLicenseGate } from '@ever-works/agent/app-runtime';
import {
    APP_RUNTIME_REMOTE_PROXIES,
    TriggerAppRuntimeModule,
    workerAppLicenseService,
} from '../trigger-app-runtime.module';

/**
 * **The App runtime worker reads the license verdict** (lane aw-managed-debug, 2026-10-18).
 *
 * `APP_LICENSE_SERVICE` was unbound in `TriggerAppRuntimeModule`, so `AppLicenseGate` had no
 * verdict to read and failed every managed Deployment closed — prod Deployment d08b60ab (run
 * `run_cmvdxu7np1zwj2y4722nqpd7c`): `license_blocks_target`, "Ever Works Apps cannot host this
 * App Work while its license classification is unreadable", although the API knew the answer.
 *
 * The module now binds it to the API's `AppLicenseService` facade over the internal channel. The
 * module is booted for real against a loopback stub of that channel, and these cases pin:
 *
 * 1. the binding is the narrow one-method reader, dialling `AppLicenseService.getHostingEligibility`
 *    with the Work id and the commit;
 * 2. a green verdict lets the gate pass `ever-works-apps`, a red one refuses with its reason;
 * 3. **fail-closed** — a failed RPC (the stub's 501, which is also what the API answers when the
 *    facade is unbound) refuses `ever-works-apps` with `license_blocks_target`, and only warns on
 *    `your-cluster`.
 */

interface RecordedRemoteCall {
    name: string;
    method: string;
    args: unknown[];
}

const GREEN = {
    none: 'allowed',
    yourCluster: 'allowed',
    managed: 'allowed',
    sourceOffer: { required: false, url: null, missing: false },
};

describe('TriggerAppRuntimeModule — APP_LICENSE_SERVICE over the internal channel', () => {
    let context: INestApplicationContext;
    let stubApi: Server;
    const remoteCalls: RecordedRemoteCall[] = [];
    let answer: { status: number; result?: unknown } = { status: 501 };

    beforeAll(async () => {
        stubApi = createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (request.url?.endsWith('/remote/call') && raw) {
                    const body = JSON.parse(raw) as {
                        name: string;
                        method: string;
                        args: { json: unknown; meta?: unknown };
                    };
                    remoteCalls.push({
                        name: body.name,
                        method: body.method,
                        args: superjson.deserialize(body.args as never) as unknown[],
                    });
                    if (
                        body.name === 'AppLicenseService' &&
                        body.method === 'getHostingEligibility' &&
                        answer.status === 200
                    ) {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({ result: superjson.serialize(answer.result) }),
                        );
                        return;
                    }
                }
                response.writeHead(501, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'Unknown remote target: AppLicenseService' }));
            });
        });
        await new Promise<void>((resolve) => stubApi.listen(0, '127.0.0.1', () => resolve()));
        const port = (stubApi.address() as { port: number }).port;
        process.env.TRIGGER_INTERNAL_API_URL = `http://127.0.0.1:${port}`;
        process.env.TRIGGER_INTERNAL_SECRET = 'license-spec-secret';

        context = await NestFactory.createApplicationContext(TriggerAppRuntimeModule, {
            abortOnError: false,
            logger: false,
        });
    }, 180_000);

    afterAll(async () => {
        await context?.close();
        await new Promise<void>((resolve) => stubApi?.close(() => resolve()));
    });

    beforeEach(() => {
        remoteCalls.length = 0;
        answer = { status: 501 };
    });

    const gate = (): AppLicenseGate =>
        context.select(TriggerAppRuntimeModule).get(AppLicenseGate, { strict: true });

    it('binds the narrow one-method reader, and names its remote target', () => {
        const bound = context
            .select(TriggerAppRuntimeModule)
            .get(APP_LICENSE_SERVICE, { strict: true }) as Record<string, unknown>;

        expect(Object.keys(bound)).toEqual(['getHostingEligibility']);
        expect(APP_RUNTIME_REMOTE_PROXIES).toContain('AppLicenseService');
    });

    it('lets a green verdict pass ever-works-apps — read from the API with the Work and commit', async () => {
        answer = { status: 200, result: GREEN };

        const result = await gate().evaluate({
            workId: 'work-1',
            target: 'ever-works-apps',
            commitSha: 'c0ffee',
        });

        expect(result.allowed).toBe(true);
        expect(result.preconditions).toEqual([]);
        expect(result.eligibility).toEqual(GREEN);
        expect(remoteCalls).toEqual([
            {
                name: 'AppLicenseService',
                method: 'getHostingEligibility',
                args: ['work-1', { commitSha: 'c0ffee' }],
            },
        ]);
    });

    it('refuses ever-works-apps with the verdict’s own reason when it is not allowed', async () => {
        answer = { status: 200, result: { ...GREEN, managed: 'licenseNotGreen' } };

        const result = await gate().evaluate({ workId: 'work-1', target: 'ever-works-apps' });

        expect(result.allowed).toBe(false);
        expect(result.preconditions).toEqual([
            expect.objectContaining({ code: 'license_blocks_target', names: ['licenseNotGreen'] }),
        ]);
    });

    it('fails CLOSED on ever-works-apps when the RPC fails — and only warns on your-cluster', async () => {
        answer = { status: 501 };

        const managed = await gate().evaluate({ workId: 'work-1', target: 'ever-works-apps' });
        expect(managed.allowed).toBe(false);
        expect(managed.preconditions.map((entry) => entry.code)).toEqual(['license_blocks_target']);
        expect(managed.warnings.map((entry) => entry.code)).toEqual([
            'license_eligibility_unavailable',
        ]);

        const own = await gate().evaluate({ workId: 'work-1', target: 'your-cluster' });
        expect(own.allowed).toBe(true);
        expect(own.warnings.map((entry) => entry.code)).toEqual([
            'license_eligibility_unavailable',
        ]);
        expect(remoteCalls.map((call) => `${call.name}.${call.method}`)).toEqual([
            'AppLicenseService.getHostingEligibility',
            'AppLicenseService.getHostingEligibility',
        ]);
    });
});

describe('workerAppLicenseService', () => {
    it('answers null — the gate’s own "unreadable" — for an absent verdict', async () => {
        const reader = workerAppLicenseService({ callRemote: async () => undefined } as never);

        await expect(reader.getHostingEligibility('work-1')).resolves.toBeNull();
    });

    it('lets a failed call throw, so the gate fails closed rather than guessing', async () => {
        const reader = workerAppLicenseService({
            callRemote: async () => {
                throw new Error('Unknown remote target: AppLicenseService');
            },
        } as never);

        await expect(reader.getHostingEligibility('work-1')).rejects.toThrow(
            'Unknown remote target',
        );
    });
});

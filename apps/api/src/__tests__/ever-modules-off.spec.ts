import 'reflect-metadata';
import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import * as request from 'supertest';
import type { DataSource } from 'typeorm';
import { ActivityLogModule, ActivityLogService } from '@ever-works/agent/activity-log';
import { DatabaseModule, ENTITIES, UserRepository } from '@ever-works/agent/database';
import {
    EVER_STATS_LEASE_ROW_ID,
    EverInstance,
    EverStatsLease,
    EverStatsReport,
} from '@ever-works/agent/entities';
import { readEverStatsConfig } from '@ever-works/agent/ever-instance';
import { FacadesModule, StatsSinkFacadeService } from '@ever-works/agent/facades';
import type { PluginRegistryService } from '@ever-works/agent/plugins';
import EverStatsSinkPlugin from '@ever-works/ever-stats-sink-plugin';
import { InstanceStatsModule, instanceStatsModuleImports } from '../instance-stats';
import { InstanceStatsSenderService } from '../instance-stats/instance-stats-sender.service';
import {
    INSTANCE_STATS_CLOCK,
    INSTANCE_STATS_CONFIG,
} from '../instance-stats/instance-stats.tokens';

/**
 * Zero outbound calls, measured: the API's statistics wiring booted for 30
 * simulated seconds with every way out of the process watched — `fetch`,
 * `http(s).request`, `net` sockets, `tls` and DNS lookups.
 *
 * 1. `EVER_STATS_ENABLED=false` — the module is absent: nothing to boot, no
 *    connection attempt, and `/api/instance-stats/status` answers 404.
 * 2. Statistics ON (the self-hosted default) on a fresh installation — the
 *    module is loaded with the REAL sender plugin, yet nothing leaves the
 *    process during boot: the first report is a day away, and the plugin opens
 *    no connection when loaded.
 * 3. Control — the same boot with a report due: exactly one request, to the
 *    statistics endpoint. Without it, (1) and (2) could pass because the spies
 *    were blind.
 * 4. The module in the graph although `EVER_STATS_ENABLED=false` (the import
 *    decision is taken when `ApiModule` is imported, so it depends on the
 *    environment being loaded first): it still does nothing — no identity, no
 *    schedule, no request, every route 404, and the sender refuses.
 *
 * The real `ApiModule` cannot be imported under this app's jest (see
 * `app-works-di-reachability.spec.ts`); it reaches the statistics module ONLY
 * through `instanceStatsModuleImports()`, which `off.spec.ts` pins in its
 * source, so booting that function's result is booting what `ApiModule` gets.
 */

const LOOPBACK = /^(127\.|::1$|localhost$|::ffff:127\.)/;

interface Attempt {
    via: string;
    target: string;
}

function hostOf(args: unknown[]): string {
    const [first, second] = args;
    if (typeof first === 'string') {
        try {
            return new URL(first).hostname;
        } catch {
            return first;
        }
    }
    if (first instanceof URL) return first.hostname;
    if (first && typeof first === 'object') {
        const options = first as { host?: string; hostname?: string; path?: string; port?: number };
        if (options.path && !options.host && !options.hostname) return `unix:${options.path}`;
        return options.hostname ?? options.host ?? 'localhost';
    }
    if (typeof first === 'number') return typeof second === 'string' ? second : 'localhost';
    return String(first);
}

@Global()
@Module({
    imports: [
        TypeOrmModule.forRoot({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        }),
        TypeOrmModule.forFeature(ENTITIES),
    ],
    providers: [UserRepository],
    exports: [TypeOrmModule, UserRepository],
})
class TestDatabaseModule {}

const sinkPlugin = new EverStatsSinkPlugin();
const registry = {
    get: (id: string) =>
        id === 'ever-stats-sink'
            ? {
                  plugin: sinkPlugin,
                  manifest: { id, capabilities: ['stats-sink'] },
                  state: 'loaded',
              }
            : undefined,
} as unknown as PluginRegistryService;

@Module({
    providers: [
        { provide: StatsSinkFacadeService, useFactory: () => new StatsSinkFacadeService(registry) },
    ],
    exports: [StatsSinkFacadeService],
})
class TestFacadesModule {}

@Module({
    providers: [{ provide: ActivityLogService, useValue: { log: async () => ({}) } }],
    exports: [ActivityLogService],
})
class TestActivityLogModule {}

async function boot(
    env: Record<string, string | undefined>,
    clock: { now: Date },
    options: { forceModule?: boolean } = {},
): Promise<INestApplication> {
    @Module({
        imports: options.forceModule ? [InstanceStatsModule] : [...instanceStatsModuleImports(env)],
    })
    class StatsRoot {}

    const moduleRef = await Test.createTestingModule({ imports: [StatsRoot] })
        .overrideModule(DatabaseModule)
        .useModule(TestDatabaseModule)
        .overrideModule(FacadesModule)
        .useModule(TestFacadesModule)
        .overrideModule(ActivityLogModule)
        .useModule(TestActivityLogModule)
        .overrideProvider(INSTANCE_STATS_CONFIG)
        .useValue(readEverStatsConfig({ NODE_ENV: 'test', ...env }))
        .overrideProvider(INSTANCE_STATS_CLOCK)
        .useValue(() => clock.now)
        .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    return app;
}

describe('Ever modules off — 30 s boot without an outbound call', () => {
    let attempts: Attempt[];
    const spies: jest.SpyInstance[] = [];

    beforeEach(() => {
        attempts = [];
        const watch = <T extends object>(target: T, method: keyof T, via: string) => {
            const original = target[method] as unknown as (...args: unknown[]) => unknown;
            spies.push(
                jest.spyOn(target, method as never).mockImplementation(function (
                    this: unknown,
                    ...args: unknown[]
                ) {
                    attempts.push({ via, target: hostOf(args) });
                    return original.apply(this, args);
                } as never),
            );
        };
        watch(http, 'request', 'http.request');
        watch(https, 'request', 'https.request');
        watch(tls, 'connect', 'tls.connect');
        watch(dns, 'lookup', 'dns.lookup');
        watch(net.Socket.prototype, 'connect', 'net.Socket.connect');
        spies.push(
            jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
                attempts.push({ via: 'fetch', target: hostOf([String(input)]) });
                return new Response(JSON.stringify({ accepted: true }), {
                    status: 202,
                    headers: { 'content-type': 'application/json' },
                });
            }),
        );
        jest.useFakeTimers({ doNotFake: ['Date', 'nextTick', 'setImmediate', 'queueMicrotask'] });
    });

    afterEach(() => {
        jest.useRealTimers();
        while (spies.length) spies.pop()?.mockRestore();
    });

    const outbound = () => attempts.filter((attempt) => !LOOPBACK.test(attempt.target));

    async function run30s(clock: { now: Date }): Promise<void> {
        for (let second = 0; second < 30; second += 1) {
            clock.now = new Date(clock.now.getTime() + 1_000);
            await jest.advanceTimersByTimeAsync(1_000);
        }
    }

    it('EVER_STATS_ENABLED=false: nothing is booted, nothing goes out, the routes are 404', async () => {
        const clock = { now: new Date() };
        const env = {
            EVER_STATS_ENABLED: 'false',
            EVER_STATS_API_URL: 'https://stats.example.test',
        };
        expect(instanceStatsModuleImports(env)).toEqual([]);
        const app = await boot(env, clock);
        try {
            await run30s(clock);
            expect(outbound()).toEqual([]);
            jest.useRealTimers();
            await request(app.getHttpServer()).get('/api/instance-stats/status').expect(404);
        } finally {
            await app.close();
        }
    });

    it('statistics on, fresh installation: the loaded module and plugin stay silent for 30 s', async () => {
        const clock = { now: new Date() };
        const app = await boot({ EVER_STATS_API_URL: 'https://stats.example.test' }, clock);
        try {
            await run30s(clock);
            expect(outbound()).toEqual([]);
            // The module IS loaded: its schedule row exists, a day out.
            const dataSource = app.get<DataSource>(getDataSourceToken());
            const schedule = await dataSource.getRepository(EverStatsLease).findOne({
                where: { id: EVER_STATS_LEASE_ROW_ID },
            });
            expect(schedule?.nextSendAt?.getTime()).toBeGreaterThan(
                clock.now.getTime() + 23 * 60 * 60 * 1000,
            );
        } finally {
            await app.close();
        }
    });

    it('control: the same boot with a report due makes one request, to the statistics endpoint only', async () => {
        const clock = { now: new Date() };
        const app = await boot({ EVER_STATS_API_URL: 'https://stats.example.test' }, clock);
        try {
            await jest.advanceTimersByTimeAsync(0);
            const dataSource = app.get<DataSource>(getDataSourceToken());
            await dataSource
                .getRepository(EverStatsLease)
                .update(
                    { id: EVER_STATS_LEASE_ROW_ID },
                    { nextSendAt: new Date(clock.now.getTime() - 1_000) },
                );
            for (let second = 0; second < 90 && outbound().length === 0; second += 1) {
                clock.now = new Date(clock.now.getTime() + 1_000);
                await jest.advanceTimersByTimeAsync(1_000);
            }
            // One report — plus, on days 1-3 of a month, the closed previous month.
            const expected = clock.now.getUTCDate() <= 3 ? 2 : 1;
            expect(outbound()).toEqual(
                Array.from({ length: expected }, () => ({
                    via: 'fetch',
                    target: 'stats.example.test',
                })),
            );
        } finally {
            await app.close();
        }
    });

    it('loaded although EVER_STATS_ENABLED=false: no identity, no schedule, no request, every route 404', async () => {
        const clock = { now: new Date() };
        const env = {
            EVER_STATS_ENABLED: 'false',
            EVER_STATS_API_URL: 'https://stats.example.test',
            EVER_STATS_SEND_INTERVAL_S: '5',
        };
        const app = await boot(env, clock, { forceModule: true });
        try {
            await run30s(clock);
            expect(outbound()).toEqual([]);
            const dataSource = app.get<DataSource>(getDataSourceToken());
            expect(await dataSource.getRepository(EverInstance).count()).toBe(0);
            expect(await dataSource.getRepository(EverStatsLease).count()).toBe(0);
            expect(await dataSource.getRepository(EverStatsReport).count()).toBe(0);

            const sender = app.get(InstanceStatsSenderService);
            expect(await sender.runDue()).toEqual({ ran: false, reason: 'env' });
            expect(await sender.sendNow()).toEqual({ ran: false, reason: 'env' });
            expect(outbound()).toEqual([]);

            jest.useRealTimers();
            for (const [method, path] of [
                ['get', '/api/instance-stats/status'],
                ['post', '/api/instance-stats/preview'],
                ['get', '/api/instance-stats/last'],
                ['post', '/api/instance-stats/send-now'],
                ['put', '/api/instance-stats/toggle'],
                ['post', '/api/instance-stats/reset-identity'],
            ] as const) {
                await request(app.getHttpServer())[method](path).expect(404);
            }
            expect(await dataSource.getRepository(EverInstance).count()).toBe(0);
        } finally {
            await app.close();
        }
    });
});

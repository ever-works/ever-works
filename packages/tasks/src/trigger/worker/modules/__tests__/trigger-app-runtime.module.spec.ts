import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import superjson from 'superjson';
import {
    APP_DEPLOY_BUILD_SOURCE,
    APP_DEPLOY_SPEC_SOURCE,
    AppDeployOrchestrator,
    AppDeployPreconditionsService,
    AppHealthService,
    AppHostsService,
    AppRenderInputBuilder,
    AppRuntimeDeletionService,
    AppVerificationTargetService,
    isAppClusterWorkerContext,
} from '@ever-works/agent/app-runtime';
import { AppRuntimeFacadeService } from '@ever-works/agent/facades';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import {
    APP_RUNTIME_REMOTE_PROXIES,
    APP_RUNTIME_TASK_QUEUE,
    AppClusterWorkerContextBootstrap,
    TriggerAppRuntimeModule,
} from '../trigger-app-runtime.module';

/**
 * APW-06 T71 (`tasks.md:1231-1235`, plan §6.4) — **does the isolated App runtime worker's module
 * actually BOOT, and does it stay isolated?**
 *
 * Nothing else answers that question. The module is instantiated only inside a Trigger.dev task and
 * by the local worker, neither of which CI runs as part of the unit suite; `tsc` cannot see a
 * missing injection token; and the API's own DI bootstrap never touches it. That is not
 * hypothetical for this programme: `TriggerWorkflowRunModule` shipped its first draft unable to
 * boot at all (its spec's docstring records the exact `CACHE_MANAGER` failure), and two App Works
 * modules declared providers injecting `DatabaseModule` repositories without importing it, which no
 * unit suite could see and only booting the API found.
 *
 * Five claims, each one a rule from §6.4:
 *
 * 1. **It boots** — every non-optional dependency in the graph resolves, with a **stubbed API
 *    client**: a loopback HTTP server that records requests and answers 501. The spec asserts the
 *    context makes **zero** requests while booting, which is the §6.2 rule that a worker boots
 *    without dialling anything.
 * 2. **The services the tasks resolve are in it** — the orchestrator (T25), the facade (T20), the
 *    deletion service (T58) and the verification service (T60).
 * 3. **No `DataSource` is in the container** — the §6.4 rule that makes §6.2's
 *    `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED` attestation achievable. `DatabaseModule` is not
 *    imported here and the spec proves it by resolving TypeORM's own token, not by grepping.
 * 4. **The worker-context flag is armed by this module's bootstrap and by nothing else** — asserted
 *    twice: the process flag is `false` before the context exists and `true` after, and a scan of
 *    `packages/tasks/src` finds exactly **one** caller of `markAppClusterWorkerContext(`.
 * 5. **§5.1's spec and Build reads are proxied by name** — `APP_DEPLOY_SPEC_SOURCE` dials the
 *    API's `AppSpecService` and `APP_DEPLOY_BUILD_SOURCE` its `AppDeployBuildSourceAdapter`, the
 *    local consumers are handed those proxies, and the render-input builder reads both across the
 *    hop. The stub answers only the `name.method` a case configures, and records what it was asked.
 */

/**
 * TypeORM's `DataSource` **class**, which is the token Nest registers it under.
 *
 * `packages/tasks` deliberately does not depend on `typeorm` — this module must never touch a
 * `DataSource`, so the package has no business importing one — and an unresolved import would fail
 * the whole suite, which is not evidence of anything. It is resolved through the package that DOES
 * own the dependency (`packages/agent`), so the token under test is the real class Nest would
 * register, not a look-alike.
 */
const agentRequire = createRequire(path.resolve(__dirname, '../../../../../agent/package.json'));
const { DataSource } = agentRequire('typeorm') as { DataSource: new (...args: never[]) => unknown };

/** Every file under `packages/tasks/src`, minus the specs and test helpers. */
function sourceFiles(root: string): string[] {
    if (!fs.existsSync(root)) return [];

    return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__' || entry.name === 'node_modules') return [];
            return sourceFiles(full);
        }
        if (!entry.name.endsWith('.ts')) return [];
        if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.test.ts')) return [];

        return [full];
    });
}

/** One `POST /remote/call` the stub API received, with its SuperJSON args decoded. */
interface RecordedRemoteCall {
    name: string;
    method: string;
    args: unknown[];
}

describe('TriggerAppRuntimeModule (APW-06 T71)', () => {
    let context: INestApplicationContext;
    let stubApi: Server;
    let stubPort = 0;
    let stubRequests = 0;
    let flagBeforeBoot = true;
    // What the stub API was asked over the RPC hop, and what it answers for a `name.method` a case
    // configures. Everything unconfigured still answers 501, exactly as before.
    const remoteCalls: RecordedRemoteCall[] = [];
    const remoteAnswers = new Map<string, unknown>();

    beforeAll(async () => {
        // The stub API client's endpoint: a loopback server that answers 501 and counts. The
        // module must boot WITHOUT calling it — asserted below.
        stubApi = createServer((request, response) => {
            stubRequests += 1;
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
                    const key = `${body.name}.${body.method}`;
                    if (remoteAnswers.has(key)) {
                        response.writeHead(200, { 'content-type': 'application/json' });
                        response.end(
                            JSON.stringify({ result: superjson.serialize(remoteAnswers.get(key)) }),
                        );
                        return;
                    }
                }
                response.writeHead(501, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'the stub answers nothing' }));
            });
        });
        await new Promise<void>((resolve) => stubApi.listen(0, '127.0.0.1', () => resolve()));
        stubPort = (stubApi.address() as { port: number }).port;

        process.env.TRIGGER_INTERNAL_API_URL = `http://127.0.0.1:${stubPort}`;
        process.env.TRIGGER_INTERNAL_SECRET = 't71-spec-secret';

        flagBeforeBoot = isAppClusterWorkerContext();

        context = await NestFactory.createApplicationContext(TriggerAppRuntimeModule, {
            abortOnError: false,
            logger: false,
        });
    }, 180_000);

    afterAll(async () => {
        await context?.close();
        await new Promise<void>((resolve) => stubApi?.close(() => resolve()));
    });

    it('boots — every non-optional dependency in the graph resolves', () => {
        expect(context).toBeDefined();
    });

    it('dials nothing while booting (the stub API recorded zero requests)', () => {
        expect(stubRequests).toBe(0);
    });

    it('provides the orchestrator the `app-deploy` task resolves', () => {
        expect(context.get(AppDeployOrchestrator, { strict: false })).toBeDefined();
    });

    it('provides the facade, the deletion service and the verification service', () => {
        expect(context.get(AppRuntimeFacadeService, { strict: false })).toBeDefined();
        expect(context.get(AppRuntimeDeletionService, { strict: false })).toBeDefined();
        expect(context.get(AppVerificationTargetService, { strict: false })).toBeDefined();
    });

    it('proxies DistributedTaskLockService instead of constructing it — it needs a DataSource', () => {
        // The lock service's own constructor is `@InjectRepository(CacheEntry)`, NON-optional, so a
        // local instance would mean a DataSource in this process. The proxy resolves instead.
        expect(context.get(DistributedTaskLockService, { strict: false })).toBeDefined();
        expect(
            typeof (context.get(DistributedTaskLockService, { strict: false }) as any).isLocked,
        ).toBe('function');
    });

    it('has NO DataSource in the container', () => {
        // §6.4's rule, asserted against TypeORM's own token. `strict: false` walks every module in
        // the graph, so a DataSource registered anywhere — including transitively — is found, and
        // the answer is the container's own "this provider does not exist in the current context".
        expect(() => context.get(DataSource as never, { strict: false })).toThrow(
            /could not find DataSource/,
        );
    });

    it('arms the worker-context flag — and it was NOT armed before this module booted', () => {
        expect(flagBeforeBoot).toBe(false);
        expect(isAppClusterWorkerContext()).toBe(true);
    });

    it('declares the bootstrap provider that is the only thing arming the flag', () => {
        expect(context.get(AppClusterWorkerContextBootstrap, { strict: false })).toBeDefined();
    });

    it('declares the `app-cluster-io` queue the four tasks register on', () => {
        expect(APP_RUNTIME_TASK_QUEUE).toEqual({ name: 'app-cluster-io', concurrencyLimit: 20 });
    });

    it('is the ONLY caller of markAppClusterWorkerContext() in packages/tasks', () => {
        const src = path.resolve(__dirname, '..', '..', '..', '..');
        const files = sourceFiles(src);

        // Vacuity control: a scan that found no files would pass every assertion below.
        expect(files.length).toBeGreaterThan(50);

        const callers = files.filter((file) =>
            fs.readFileSync(file, 'utf8').includes('markAppClusterWorkerContext('),
        );

        expect(callers.map((file) => path.relative(src, file).replace(/\\/g, '/'))).toEqual([
            'trigger/worker/modules/trigger-app-runtime.module.ts',
        ]);
    });

    /**
     * §5.1's two reads — the App spec at a commit and the Build a Deployment names — proxied by
     * name to the API's own bindings (plan §6.4 marks APW-05's `WorkBuild` reads "Proxied"). The
     * render-input builder, the preconditions pass the orchestrator re-runs, `AppHostsService` and
     * `AppHealthService` all read them in THIS process. Unbound, the builder answered
     * `no_green_build` ("could not be read") for every Build-backed Deployment and
     * `spec_unavailable` for every other one, and the health poll had no component list to judge.
     */
    describe('the §5.1 spec and Build sources (proxied to the API, never local)', () => {
        const GREEN_BUILD = {
            id: 'build-1',
            commitSha: 'c0ffee',
            status: 'succeeded',
            trigger: 'push',
            imageReference: `ghcr.io/acme/app@sha256:${'a'.repeat(64)}`,
        };

        afterEach(() => remoteAnswers.clear());

        it('binds APP_DEPLOY_SPEC_SOURCE to the API’s AppSpecService, reached by name', async () => {
            const snapshot = {
                status: 'valid',
                commitSha: 'c0ffee',
                spec: { build: { strategy: 'image' } },
            };
            remoteAnswers.set('AppSpecService.getEffectiveSpec', snapshot);
            const source = context.get(APP_DEPLOY_SPEC_SOURCE, { strict: false }) as {
                getEffectiveSpec(workId: string, commitSha?: string | null): Promise<unknown>;
            };

            await expect(source.getEffectiveSpec('work-1', 'c0ffee')).resolves.toEqual(snapshot);
            expect(remoteCalls.at(-1)).toEqual({
                name: 'AppSpecService',
                method: 'getEffectiveSpec',
                args: ['work-1', 'c0ffee'],
            });
        });

        it('binds APP_DEPLOY_BUILD_SOURCE to the API’s AppDeployBuildSourceAdapter — both reads', async () => {
            remoteAnswers.set('AppDeployBuildSourceAdapter.getBuild', GREEN_BUILD);
            remoteAnswers.set('AppDeployBuildSourceAdapter.listDeployableBuilds', [GREEN_BUILD]);
            const source = context.get(APP_DEPLOY_BUILD_SOURCE, { strict: false }) as {
                getBuild(workId: string, buildId: string): Promise<unknown>;
                listDeployableBuilds(workId: string): Promise<unknown>;
            };

            await expect(source.getBuild('work-1', 'build-1')).resolves.toEqual(GREEN_BUILD);
            await expect(source.listDeployableBuilds('work-1')).resolves.toEqual([GREEN_BUILD]);
            expect(remoteCalls.slice(-2)).toEqual([
                {
                    name: 'AppDeployBuildSourceAdapter',
                    method: 'getBuild',
                    args: ['work-1', 'build-1'],
                },
                {
                    name: 'AppDeployBuildSourceAdapter',
                    method: 'listDeployableBuilds',
                    args: ['work-1'],
                },
            ]);
        });

        it('hands those same two instances to every local consumer that injects them', () => {
            const specs = context.get(APP_DEPLOY_SPEC_SOURCE, { strict: false });
            const builds = context.get(APP_DEPLOY_BUILD_SOURCE, { strict: false });
            const preconditions = context.get(AppDeployPreconditionsService, {
                strict: false,
            }) as any;
            const renderer = context.get(AppRenderInputBuilder, { strict: false }) as any;

            expect(preconditions.specs).toBe(specs);
            expect(preconditions.builds).toBe(builds);
            expect(renderer.specs).toBe(specs);
            expect(renderer.builds).toBe(builds);
            expect((context.get(AppHostsService, { strict: false }) as any).specs).toBe(specs);
            expect((context.get(AppHealthService, { strict: false }) as any).specs).toBe(specs);
        });

        it('lets the render-input builder read the Build, then the spec AT THE BUILD’S COMMIT, across the hop', async () => {
            remoteAnswers.set('AppDeployBuildSourceAdapter.getBuild', GREEN_BUILD);
            // `none` is the one strategy whose refusal is reachable ONLY after both reads
            // succeeded: a green Build with an image, then a usable spec at that Build's commit.
            remoteAnswers.set('AppSpecService.getEffectiveSpec', {
                status: 'valid',
                commitSha: 'c0ffee',
                spec: { build: { strategy: 'none' } },
            });
            const renderer = context.get(AppRenderInputBuilder, { strict: false });
            const before = remoteCalls.length;

            const result = await renderer.build({
                workId: 'work-1',
                workSlug: 'acme-app',
                ref: { workId: 'work-1', namespace: 'ew-acme-app', target: 'your-cluster' },
                deploymentId: 'deployment-1',
                buildId: 'build-1',
            } as never);

            expect(result).toMatchObject({ status: 'unavailable', code: 'nothing_to_deploy' });
            // ACC-06-20: the spec is read at the Build's own commit, and nothing else crossed.
            expect(remoteCalls.slice(before)).toEqual([
                {
                    name: 'AppDeployBuildSourceAdapter',
                    method: 'getBuild',
                    args: ['work-1', 'build-1'],
                },
                { name: 'AppSpecService', method: 'getEffectiveSpec', args: ['work-1', 'c0ffee'] },
            ]);
        });

        it('keeps the worker DataSource-free — both reads are proxies, not local repositories', () => {
            // The API binds the Build source to an adapter over `AppBuildRepository`, which needs
            // a DataSource; the worker must reach that adapter by name instead of constructing it.
            expect(() => context.get(DataSource as never, { strict: false })).toThrow(
                /could not find DataSource/,
            );
            // And the module's own list of the names it dials says so.
            expect(APP_RUNTIME_REMOTE_PROXIES).toEqual(
                expect.arrayContaining(['AppSpecService', 'AppDeployBuildSourceAdapter']),
            );
        });
    });
});

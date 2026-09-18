import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import {
    AppDeployOrchestrator,
    AppRuntimeDeletionService,
    AppVerificationTargetService,
    isAppClusterWorkerContext,
} from '@ever-works/agent/app-runtime';
import { AppRuntimeFacadeService } from '@ever-works/agent/facades';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import {
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
 * Four claims, each one a rule from §6.4:
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

describe('TriggerAppRuntimeModule (APW-06 T71)', () => {
    let context: INestApplicationContext;
    let stubApi: Server;
    let stubPort = 0;
    let stubRequests = 0;
    let flagBeforeBoot = true;

    beforeAll(async () => {
        // The stub API client's endpoint: a loopback server that answers 501 and counts. The
        // module must boot WITHOUT calling it — asserted below.
        stubApi = createServer((_request, response) => {
            stubRequests += 1;
            response.writeHead(501, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'the stub answers nothing' }));
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
});

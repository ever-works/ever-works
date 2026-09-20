import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';

/**
 * Workspace backup (AW-22) — can the two tasks resolve what they resolve?
 *
 * Both of them could not, and neither had a spec. `appContext.get(SomeClass)`
 * type-checks against any class, so a type-check proves nothing here; the
 * only thing that proves it is asking a real container.
 *
 *  - `workspace-backup` resolved `WorkspaceBackupRunner`,
 *    `WorkspaceBackupRepository` and `WorkspaceBackupService` from the
 *    default `TriggerWorkerModule`, which provides none of them, so every
 *    dispatched backup died with `Nest could not find
 *    WorkspaceBackupRunner element` and the row sat at `queued` forever.
 *  - `workspace-backup-sweeper` resolved `WorkspaceBackupService` and
 *    `DistributedTaskLockService` from `TriggerInternalModule`, which has no
 *    `imports` at all and listed neither — so the hourly cron threw before
 *    any pass ran, and retention, stall-failure and record pruning have
 *    never executed anywhere.
 *
 * The sweeper's context module is booted for real below, because it can be:
 * its whole graph is RPC proxies over one API client. The archive task's
 * module (`TriggerWorkerModule`) reaches the same providers through its
 * import of this one, which is asserted structurally rather than by booting
 * the plugin host.
 */

const { triggerConfig } = vi.hoisted(() => ({
    triggerConfig: {
        shouldUseTrigger: vi.fn(),
        getSecretKey: vi.fn(),
        getApiUrl: vi.fn(),
        getMachine: vi.fn(),
        getInternalBaseUrl: vi.fn(() => 'http://api.test.svc.cluster.local/internal/trigger'),
        getInternalSecret: vi.fn(() => 'test-secret'),
        getInternalRequestTimeoutMs: vi.fn(() => 45000),
    },
}));

vi.mock('@trigger.dev/sdk', () => ({
    configure: vi.fn(),
    runs: { cancel: vi.fn() },
    task: vi.fn().mockImplementation(() => ({ id: 'mock-task' })),
    schedules: { task: vi.fn().mockImplementation(() => ({ id: 'mock-schedule-task' })) },
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@ever-works/agent/config', () => ({
    config: {
        trigger: triggerConfig,
        subscriptions: { getDispatchIntervalMinutes: vi.fn(() => 5) },
    },
}));

const { WorkspaceBackupRunner, WorkspaceBackupService } =
    await import('@ever-works/agent/account-transfer');
const { WorkspaceBackupRepository } = await import('@ever-works/agent/database');
const { TriggerInternalModule } = await import('../trigger/worker/modules/trigger-internal.module');
const { TriggerWorkerModule } = await import('../trigger/worker/modules/trigger-worker.module');

describe('workspace-backup task wiring', () => {
    describe('the sweeper’s context module, booted', () => {
        let context: INestApplicationContext;

        beforeAll(async () => {
            context = await NestFactory.createApplicationContext(TriggerInternalModule, {
                logger: false,
            });
        });

        afterAll(async () => {
            await context?.close();
        });

        it('resolves WorkspaceBackupService — the token the cron dies on', () => {
            expect(context.get(WorkspaceBackupService)).toBeDefined();
        });

        it('exposes runSweep, the one method the cron calls', () => {
            const service = context.get(WorkspaceBackupService) as unknown as {
                runSweep: unknown;
            };
            // It is an RPC proxy, so every property answers with a
            // forwarding function; what matters is that the call the task
            // makes is reachable rather than an UnknownElementException.
            expect(typeof service.runSweep).toBe('function');
        });

        it('resolves the runner and the repository the archive task also gets', () => {
            expect(context.get(WorkspaceBackupRunner)).toBeDefined();
            expect(context.get(WorkspaceBackupRepository)).toBeDefined();
        });
    });

    describe('the archive task’s context module', () => {
        function meta(key: 'imports' | 'exports', target: unknown): unknown[] {
            return (Reflect.getMetadata(key, target as object) as unknown[]) ?? [];
        }

        it('imports the module that provides the three backup tokens', () => {
            expect(meta('imports', TriggerWorkerModule)).toContain(TriggerInternalModule);
        });

        it('reaches all three through that import', () => {
            const exported = meta('exports', TriggerInternalModule);
            expect(exported).toContain(WorkspaceBackupRunner);
            expect(exported).toContain(WorkspaceBackupService);
            expect(exported).toContain(WorkspaceBackupRepository);
        });
    });

    describe('the sweeper no longer needs a lock it cannot construct', () => {
        it('does not name DistributedTaskLockService', async () => {
            // The lock injects `@InjectRepository(CacheEntry)` and the worker
            // has no DataSource, so it cannot be built in worker scope under
            // ANY wiring — and `runExclusive` takes a callback, which cannot
            // cross the RPC boundary either. The three passes and their locks
            // are composed API-side as `runSweep()` instead.
            const source = await import('node:fs').then((fs) =>
                fs.readFileSync(
                    new URL('../tasks/trigger/workspace-backup-sweeper.task.ts', import.meta.url),
                    'utf8',
                ),
            );
            expect(source).not.toMatch(/appContext\.get\(DistributedTaskLockService\)/);
            expect(source).toMatch(/runSweep\(/);
        });
    });
});

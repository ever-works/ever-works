import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { WorkflowGraphExecutorService, WORKFLOW_NODE_RUNNER } from '@ever-works/agent/agents';
import { KnowledgeBaseService, WorkflowRunExecutorService } from '@ever-works/agent/services';
import { TriggerWorkflowRunModule } from '../trigger-workflow-run.module';

/**
 * Does the `workflow-run` worker context actually BOOT?
 *
 * Nothing else in the pipeline answers that question. The module is
 * instantiated only inside a Trigger.dev task, which CI never runs; the
 * API's own DI bootstrap never touches it; and `tsc` cannot see a missing
 * injection token. So a DI fault here fails for the first time in
 * production, on every workflow run, silently.
 *
 * That is not hypothetical — this module shipped its first draft unable
 * to boot at all. `TriggerPluginsModule` provides
 * `PluginContextFactoryService`, whose sixth constructor argument is a
 * NON-optional `@Inject(CACHE_MANAGER)` that nothing in the plugins
 * module supplies, so the context died with:
 *
 *     Nest can't resolve dependencies of the PluginContextFactoryService
 *     (..., ?). Please make sure that the argument "CACHE_MANAGER" at
 *     index [5] is available in the TriggerPluginsModule module.
 *
 * The fix was importing `TriggerRemoteCacheModule.forRoot()`, which
 * `TriggerWorkerModule` had been carrying all along. This spec is what
 * makes the next such gap fail in a unit test instead.
 *
 * It asserts more than "it booted": a context that boots but leaves
 * `WORKFLOW_NODE_RUNNER` unbound would validate a graph and then refuse
 * to execute a single node, reporting `no-node-runner` on every run —
 * which is precisely the silent-no-op the whole seam exists to prevent.
 */
describe('TriggerWorkflowRunModule', () => {
    let context: INestApplicationContext;

    beforeAll(async () => {
        // `TriggerPluginsModule` imports `TriggerInternalModule`, whose
        // API client THROWS in its constructor when the URL is unset — so
        // this must be present even though the module talks to the DB
        // directly. In-memory sqlite keeps the DataSource real without a
        // server.
        process.env.TRIGGER_INTERNAL_API_URL ??= 'http://localhost:3100';
        process.env.TRIGGER_INTERNAL_SECRET ??= 'test-secret';
        process.env.DATABASE_TYPE ??= 'better-sqlite3';
        process.env.DATABASE_PATH ??= ':memory:';
        process.env.DATABASE_AUTOMIGRATE ??= 'true';
        process.env.RUN_MIGRATIONS ??= 'false';

        context = await NestFactory.createApplicationContext(TriggerWorkflowRunModule, {
            abortOnError: false,
            logger: false,
        });
    }, 120_000);

    afterAll(async () => {
        await context?.close();
    });

    it('boots — every non-optional dependency in the graph resolves', () => {
        expect(context).toBeDefined();
    });

    it('provides the service the task actually calls', () => {
        expect(context.get(WorkflowRunExecutorService, { strict: false })).toBeDefined();
    });

    it('binds WORKFLOW_NODE_RUNNER — without it every run reports `no-node-runner`', () => {
        // The token, and the executor's own view of it. Checking only the
        // token would pass while the executor still injected `undefined`.
        expect(context.get(WORKFLOW_NODE_RUNNER, { strict: false })).toBeDefined();
        const executor = context.get(WorkflowGraphExecutorService, {
            strict: false,
        }) as unknown as {
            runner?: unknown;
            decider?: unknown;
        };
        expect(executor.runner).toBeDefined();
    });

    it('binds the llm_decide decider, so a decision goes through the AI facade', () => {
        const executor = context.get(WorkflowGraphExecutorService, {
            strict: false,
        }) as unknown as {
            decider?: unknown;
        };
        expect(executor.decider).toBeDefined();
    });

    it('provides KnowledgeBaseService, so a kb.search node is not dead on arrival', () => {
        expect(context.get(KnowledgeBaseService, { strict: false })).toBeDefined();
    });
});

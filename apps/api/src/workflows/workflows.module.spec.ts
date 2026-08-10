/**
 * api-side WorkflowsModule — the durable guard that a saved workflow can
 * actually be RUN.
 *
 * `WORKFLOW_RUN_DISPATCHER` is bound in this module, but its only
 * consumer — `WorkflowRunsService` — is declared in the agent-side
 * `WorkflowsModule` that this module IMPORTS. NestJS resolves a
 * provider's dependencies in the injector of the module that DECLARES
 * it and never walks upward into an importer, so a plain `@Module`
 * binding here is invisible to the service and its `@Optional()`
 * injection resolves to `undefined`.
 *
 * That failure is total and completely silent: every
 * `POST /api/workflows/:id/run` takes the "no dispatcher bound" branch,
 * records the run as dispatch-failed, and still answers 202. The graph is
 * never walked, while the 202, the persisted row, green unit tests and
 * green CI all read as a working feature.
 *
 * Nothing else in the pipeline catches it:
 *   - no boot error, because the token is deliberately `@Optional()`;
 *   - `workflow-runs.service.spec.ts` constructs the service directly
 *     with a mock dispatcher, so DI is never exercised;
 *   - CI and e2e run without Trigger.dev configured, where a
 *     dispatch-failed run is the EXPECTED result anyway;
 *   - `generate:openapi` runs Nest in PREVIEW mode and never instantiates
 *     a provider.
 *
 * The repo has hit this exact trap twice before —
 * `IdeaBuildExecutorDispatchModule` and `TasksModule`, the latter marked
 * "PASS-4 review fix (CRITICAL)" — and both fixed it with `@Global()`.
 * This spec is what stops a fourth.
 *
 * Mocking posture mirrors `agents/agents.module.spec.ts`: stub the heavy
 * workspace barrels at module scope so the decorator metadata can be
 * asserted without dragging the entity/zod graph through Jest's CJS
 * transformer. The dispatcher token is a SYMBOL, so the stub declares it
 * once and both this spec and the module under test receive the same
 * instance — the assertion stays honest.
 */

jest.mock('@ever-works/agent/services', () => ({
    WorkflowsModule: class AgentWorkflowsModule {},
}));
jest.mock('@ever-works/agent/tasks', () => ({
    WORKFLOW_RUN_DISPATCHER: Symbol('WORKFLOW_RUN_DISPATCHER'),
}));
jest.mock('@ever-works/trigger-tasks', () => ({
    workflowRunTriggerAdapter: { dispatchWorkflowRun: async () => null },
}));
jest.mock('../auth/auth.module', () => ({ AuthModule: class AuthModule {} }));
jest.mock('./workflows.controller', () => ({
    WorkflowsController: class WorkflowsController {},
}));

import { WORKFLOW_RUN_DISPATCHER } from '@ever-works/agent/tasks';
import { workflowRunTriggerAdapter } from '@ever-works/trigger-tasks';
import { WorkflowsModule } from './workflows.module';

describe('WorkflowsModule (api) — run dispatch wiring', () => {
    /** Nest's own metadata key, read as the framework writes it. */
    const GLOBAL_MODULE_METADATA = '__module:global__';

    it('is @Global() — without it the dispatcher never reaches WorkflowRunsService', () => {
        expect(Reflect.getMetadata(GLOBAL_MODULE_METADATA, WorkflowsModule)).toBe(true);
    });

    it('binds WORKFLOW_RUN_DISPATCHER to the Trigger.dev adapter', () => {
        const providers = Reflect.getMetadata('providers', WorkflowsModule) ?? [];
        const binding = providers.find(
            (provider: unknown) =>
                typeof provider === 'object' &&
                provider !== null &&
                (provider as { provide?: unknown }).provide === WORKFLOW_RUN_DISPATCHER,
        );
        expect(binding).toBeDefined();
        // Bound to the real adapter, not a placeholder — a `useValue: null`
        // would satisfy "the token exists" and still never enqueue.
        expect((binding as { useValue?: unknown }).useValue).toBe(workflowRunTriggerAdapter);
    });

    it('exports the token so an importing module can consume it too', () => {
        const exported = Reflect.getMetadata('exports', WorkflowsModule) ?? [];
        expect(exported).toContain(WORKFLOW_RUN_DISPATCHER);
    });

    it('still mounts the controller and imports the agent-side module', () => {
        // Guards the other half: a module that binds the dispatcher but
        // stops serving the routes would pass every check above.
        expect(Reflect.getMetadata('controllers', WorkflowsModule) ?? []).toHaveLength(1);
        expect(Reflect.getMetadata('imports', WorkflowsModule) ?? []).toHaveLength(2);
    });
});

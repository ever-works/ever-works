import { describe, it, expect } from 'vitest';
import {
    PLUGIN_OPERATION_DISPATCH_METHOD,
    PLUGIN_OPERATION_TASK_ID,
} from '@ever-works/agent/tasks';
import { runPluginOperationTask } from '../tasks/trigger/run-plugin-operation.task';
import { TriggerService } from '../trigger/trigger.service';
import { TriggerJobRuntimeProvider } from '../trigger/trigger-job-runtime.provider';

/**
 * EW-693 / T27 — the three places that must agree on two strings, with NOTHING
 * mocked.
 *
 * `PluginExecutionRouterService` looks the dispatcher up by name
 * (`PLUGIN_OPERATION_DISPATCH_METHOD`) on the active job runtime's
 * `dispatchers`; `TriggerService.dispatchPluginOperation` triggers
 * `PLUGIN_OPERATION_TASK_ID`; the worker task registers under an id. Every
 * other spec mocks at least one side with a literal, so a rename on one side
 * stayed green while every long-running dispatch in production answered
 * JOB_RUNTIME_UNAVAILABLE (no method) or DISPATCH_FAILED (no such task).
 */
describe('run-plugin-operation wiring — the real task, service and agent constants', () => {
    it('the worker task registers under the id the dispatcher triggers', () => {
        expect(runPluginOperationTask.id).toBe(PLUGIN_OPERATION_TASK_ID);
    });

    it('TriggerService implements the dispatch method the router looks up by name', () => {
        expect(
            typeof (TriggerService.prototype as unknown as Record<string, unknown>)[
                PLUGIN_OPERATION_DISPATCH_METHOD
            ],
        ).toBe('function');
    });

    it('the Trigger.dev job runtime exposes it on its dispatchers, with getRunResult to wait on', () => {
        const provider = new TriggerJobRuntimeProvider(new TriggerService());

        expect(
            typeof (provider.dispatchers as unknown as Record<string, unknown>)[
                PLUGIN_OPERATION_DISPATCH_METHOD
            ],
        ).toBe('function');
        expect(typeof provider.getRunResult).toBe('function');
    });
});

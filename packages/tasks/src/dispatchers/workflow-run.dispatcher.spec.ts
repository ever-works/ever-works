import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `tasks` is the only SDK import this adapter should have. The mock factory
// deliberately does NOT provide `logger`: if the adapter reaches for the SDK
// logger again, the import resolves to `undefined` and these tests fail rather
// than quietly writing to a `NoopTaskLogger` in production.
vi.mock('@trigger.dev/sdk', () => ({
    tasks: { trigger: vi.fn() },
}));

import { Logger } from '@nestjs/common';
import { tasks } from '@trigger.dev/sdk';
import { workflowRunTriggerAdapter } from './workflow-run.dispatcher';

const PAYLOAD = {
    workflowRunId: '11111111-1111-4111-8111-111111111111',
    workflowId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    // Spy on the prototype: the adapter holds a module-scope Logger instance
    // created at import time, so patching the instance is not an option.
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

describe('workflowRunTriggerAdapter', () => {
    it('returns the Trigger.dev run handle id and keys idempotency on the run row', async () => {
        vi.mocked(tasks.trigger).mockResolvedValue({ id: 'run_abc' } as never);

        const result = await workflowRunTriggerAdapter.dispatchWorkflowRun(PAYLOAD);

        expect(result).toBe('run_abc');
        expect(tasks.trigger).toHaveBeenCalledWith('workflow-run', PAYLOAD, {
            idempotencyKey: PAYLOAD.workflowRunId,
        });
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('LOGS the reason through a Nest logger before collapsing a failure to null', async () => {
        vi.mocked(tasks.trigger).mockRejectedValue(new Error('trigger unreachable'));

        const result = await workflowRunTriggerAdapter.dispatchWorkflowRun(PAYLOAD);

        // The contract: null, never a throw — the caller has already persisted
        // the run row and marks it dispatch-failed.
        expect(result).toBeNull();

        // The regression this pins: the adapter used `logger` from
        // `@trigger.dev/sdk`, whose run-scoped LoggerAPI resolves to a
        // `NoopTaskLogger` outside a task run. This adapter only ever executes
        // in the API process, so every dispatch failure was discarded and an
        // auth error, a malformed payload and an unreachable Trigger.dev API
        // all reached the operator as the same silent `null`.
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const [message] = errorSpy.mock.calls[0] as [string, string | undefined];
        expect(message).toContain('workflow-run dispatch failed');
        expect(message).toContain(PAYLOAD.workflowRunId);
        expect(message).toContain(PAYLOAD.workflowId);
        expect(message).toContain('trigger unreachable');
    });

    it('stringifies a non-Error rejection instead of losing it', async () => {
        vi.mocked(tasks.trigger).mockRejectedValue('plain-string-failure');

        const result = await workflowRunTriggerAdapter.dispatchWorkflowRun(PAYLOAD);

        expect(result).toBeNull();
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy.mock.calls[0][0]).toContain('plain-string-failure');
    });
});

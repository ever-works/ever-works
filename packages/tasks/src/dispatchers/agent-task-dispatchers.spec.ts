import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@trigger.dev/sdk', () => ({
    tasks: { trigger: vi.fn().mockResolvedValue({ id: 'run_123' }) },
}));

import { tasks } from '@trigger.dev/sdk';
import {
    agentChatReplyTriggerAdapter,
    agentTaskExecuteTriggerAdapter,
} from './agent-task-dispatchers';

const PAYLOAD = {
    agentId: 'agent-1',
    userId: 'user-1',
    taskId: 'task-1',
    dedupKey: 'task-1:agent-1:1',
};

const CHAT_PAYLOAD = { ...PAYLOAD, triggeringMessageId: 'msg-1' };

const RUNTIME_ENVS = ['TRIGGER_ENABLED', 'TRIGGER_SECRET_KEY', 'TRIGGER_INTERNAL_SECRET'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
    saved = Object.fromEntries(RUNTIME_ENVS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
    for (const k of RUNTIME_ENVS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    vi.clearAllMocks();
});

function unconfigure() {
    for (const k of RUNTIME_ENVS) delete process.env[k];
}

function configure() {
    process.env.TRIGGER_ENABLED = 'true';
    process.env.TRIGGER_SECRET_KEY = 'tr_secret';
    process.env.TRIGGER_INTERNAL_SECRET = 'internal_secret';
}

describe('dispatcher adapters — loud degradation gate', () => {
    it('throws the stably-named JobRuntimeNotConfiguredError when the runtime is unconfigured', async () => {
        unconfigure();
        await expect(agentTaskExecuteTriggerAdapter.enqueue(PAYLOAD)).rejects.toMatchObject({
            name: 'JobRuntimeNotConfiguredError',
        });
        await expect(agentChatReplyTriggerAdapter.enqueue(CHAT_PAYLOAD)).rejects.toMatchObject({
            name: 'JobRuntimeNotConfiguredError',
        });
        // The SDK was never reached — no opaque network/auth error can mask
        // the misconfiguration.
        expect(tasks.trigger).not.toHaveBeenCalled();
    });

    it('the error message is actionable, not an SDK stack trace', async () => {
        unconfigure();
        await expect(agentTaskExecuteTriggerAdapter.enqueue(PAYLOAD)).rejects.toThrow(
            /job runtime is not configured/i,
        );
    });

    it('enqueues normally when the runtime is configured', async () => {
        configure();
        const handle = await agentTaskExecuteTriggerAdapter.enqueue(PAYLOAD);
        expect(handle).toEqual({ runId: 'run_123' });
        expect(tasks.trigger).toHaveBeenCalledWith(
            'agent-task-execute',
            expect.objectContaining({ taskId: 'task-1' }),
            { idempotencyKey: PAYLOAD.dedupKey },
        );
    });
});

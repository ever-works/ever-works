import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@trigger.dev/sdk', () => ({
    tasks: { trigger: vi.fn().mockResolvedValue({ id: 'run_123' }) },
}));

import { tasks } from '@trigger.dev/sdk';
import {
    agentChatReplyTriggerAdapter,
    agentTaskExecuteTriggerAdapter,
    terminalSessionTriggerAdapter,
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

/**
 * The `terminal-session` task shipped with NO producer: its id appeared
 * only in its own definition and the barrel export, so no session was ever
 * started. These pin the producer that closes the loop.
 */
describe('terminalSessionTriggerAdapter', () => {
    const TERMINAL_PAYLOAD = {
        runId: '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f',
        userId: 'user-1',
        agentId: 'agent-1',
        command: ['/bin/bash', '-i'],
        cwd: '/work/task-42',
        persistent: true,
    };

    it('triggers the terminal-session task with the payload the task destructures', async () => {
        configure();
        const handle = await terminalSessionTriggerAdapter.enqueue(TERMINAL_PAYLOAD);

        expect(handle).toEqual({ jobRunId: 'run_123' });
        expect(tasks.trigger).toHaveBeenCalledWith(
            'terminal-session',
            expect.objectContaining({
                runId: TERMINAL_PAYLOAD.runId,
                userId: 'user-1',
                agentId: 'agent-1',
                command: ['/bin/bash', '-i'],
                cwd: '/work/task-42',
                persistent: true,
            }),
            expect.anything(),
        );
    });

    it('keys idempotency on the run id — the relay channel IS the run', async () => {
        configure();
        await terminalSessionTriggerAdapter.enqueue(TERMINAL_PAYLOAD);
        expect(tasks.trigger).toHaveBeenCalledWith('terminal-session', expect.anything(), {
            idempotencyKey: `terminal-session:${TERMINAL_PAYLOAD.runId}`,
        });
    });

    it('degrades loudly (never reaching the SDK) on an unconfigured install', async () => {
        unconfigure();
        await expect(terminalSessionTriggerAdapter.enqueue(TERMINAL_PAYLOAD)).rejects.toMatchObject(
            { name: 'JobRuntimeNotConfiguredError' },
        );
        expect(tasks.trigger).not.toHaveBeenCalled();
    });
});

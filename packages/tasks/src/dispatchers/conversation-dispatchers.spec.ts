import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@trigger.dev/sdk', () => ({
    tasks: { trigger: vi.fn().mockResolvedValue({ id: 'run_conv_1' }) },
}));

import { tasks } from '@trigger.dev/sdk';
import { agentConversationReplyTriggerAdapter } from './conversation-dispatchers';

const PAYLOAD = {
    agentId: 'agent-1',
    userId: 'user-1',
    conversationId: 'conversation-1',
    triggeringMessageId: 'message-1',
    dedupKey: 'conversation:message-1:agent-1:run-1',
    runId: 'run-1',
    tenantId: 'tenant-1',
    organizationId: 'org-1',
};

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

describe('agentConversationReplyTriggerAdapter', () => {
    it('rejects — never resolves — when no job runtime is configured', async () => {
        for (const k of RUNTIME_ENVS) delete process.env[k];

        await expect(agentConversationReplyTriggerAdapter.enqueue(PAYLOAD)).rejects.toMatchObject({
            name: 'JobRuntimeNotConfiguredError',
        });
        // The SDK is never reached, so no opaque network error can mask it.
        expect(tasks.trigger).not.toHaveBeenCalled();
    });

    it('enqueues the conversation reply job with the dedup key as idempotency key', async () => {
        process.env.TRIGGER_ENABLED = 'true';
        process.env.TRIGGER_SECRET_KEY = 'tr_secret';
        process.env.TRIGGER_INTERNAL_SECRET = 'internal_secret';

        const handle = await agentConversationReplyTriggerAdapter.enqueue(PAYLOAD);

        expect(handle).toEqual({ runId: 'run_conv_1' });
        expect(tasks.trigger).toHaveBeenCalledWith(
            'agent-conversation-reply',
            {
                agentId: 'agent-1',
                userId: 'user-1',
                conversationId: 'conversation-1',
                triggeringMessageId: 'message-1',
                dedupKey: PAYLOAD.dedupKey,
                runId: 'run-1',
            },
            { idempotencyKey: PAYLOAD.dedupKey },
        );
    });
});

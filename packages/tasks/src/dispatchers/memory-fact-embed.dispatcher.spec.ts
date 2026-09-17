import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `tasks` is the only SDK import this adapter may have: the mock deliberately
// omits `logger`, so reaching for the SDK logger (a no-op outside a run)
// would fail these tests instead of silently discarding dispatch failures.
vi.mock('@trigger.dev/sdk', () => ({
    tasks: { trigger: vi.fn() },
}));

import { Logger } from '@nestjs/common';
import { tasks } from '@trigger.dev/sdk';
import { memoryFactEmbedTriggerAdapter } from './memory-fact-embed.dispatcher';

const PAYLOAD = {
    factId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

describe('memoryFactEmbedTriggerAdapter', () => {
    it('enqueues memory-fact-embed with ids only and returns the run id', async () => {
        vi.mocked(tasks.trigger).mockResolvedValue({ id: 'run_1' } as never);

        await expect(memoryFactEmbedTriggerAdapter.dispatchMemoryFactEmbed(PAYLOAD)).resolves.toBe(
            'run_1',
        );
        expect(tasks.trigger).toHaveBeenCalledWith('memory-fact-embed', PAYLOAD);
    });

    it('carries no idempotency key — an edit must not collapse into the creation embed', async () => {
        vi.mocked(tasks.trigger).mockResolvedValue({ id: 'run_1' } as never);
        await memoryFactEmbedTriggerAdapter.dispatchMemoryFactEmbed(PAYLOAD);
        expect(vi.mocked(tasks.trigger).mock.calls[0]).toHaveLength(2);
    });

    it('logs and returns null on failure — never throws into the save path', async () => {
        vi.mocked(tasks.trigger).mockRejectedValue(new Error('runtime unreachable'));

        await expect(
            memoryFactEmbedTriggerAdapter.dispatchMemoryFactEmbed(PAYLOAD),
        ).resolves.toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('runtime unreachable'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(PAYLOAD.factId));
    });
});

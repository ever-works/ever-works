import {
    MEMORY_FACT_EMBED_JOB_ID,
    MEMORY_FACT_GC_CRON,
    MEMORY_FACT_GC_JOB_ID,
    parseMemoryFactEmbedPayload,
    runMemoryFactEmbedJob,
    runMemoryFactGcJob,
} from '../memory-fact-jobs';

/**
 * AW-07 — the runtime-neutral memory-fact job handlers. Every job-runtime
 * provider registers these (Trigger.dev tasks, BullMQ / pg-boss worker
 * hosts), so their boundary behaviour is pinned once, here.
 */
describe('memory-fact jobs (runtime-neutral)', () => {
    const FACT_ID = '11111111-1111-4111-8111-111111111111';

    it('pins the job ids and the sweep cron every runtime registers under', () => {
        expect(MEMORY_FACT_EMBED_JOB_ID).toBe('memory-fact-embed');
        expect(MEMORY_FACT_GC_JOB_ID).toBe('memory-fact-gc');
        expect(MEMORY_FACT_GC_CRON).toBe('13 4 * * *');
    });

    it('forwards embedFact(factId) and returns the outcome untouched — including "unavailable"', async () => {
        const embedFact = jest
            .fn()
            .mockResolvedValue({ status: 'unavailable', factId: FACT_ID, reason: 'no provider' });
        await expect(
            runMemoryFactEmbedJob({ factId: FACT_ID, userId: 'u-1' }, { embedFact }),
        ).resolves.toEqual({ status: 'unavailable', factId: FACT_ID, reason: 'no provider' });
        expect(embedFact).toHaveBeenCalledWith(FACT_ID);
    });

    it.each([["1' OR 1=1"], ['../../etc/passwd'], [42], [undefined]])(
        'refuses a non-UUID fact id (%p) before the embed service is called',
        async (factId) => {
            const embedFact = jest.fn();
            await expect(
                runMemoryFactEmbedJob({ factId, userId: 'u-1' }, { embedFact }),
            ).rejects.toThrow(/Invalid payload\.factId: expected a UUID/);
            expect(embedFact).not.toHaveBeenCalled();
        },
    );

    it('refuses a missing payload', () => {
        expect(() => parseMemoryFactEmbedPayload(null)).toThrow(/Invalid payload\.factId/);
    });

    it('passes userId through as a log-only string', () => {
        expect(parseMemoryFactEmbedPayload({ factId: FACT_ID, userId: 7 })).toEqual({
            factId: FACT_ID,
            userId: '',
        });
    });

    it('runs one sweep pass', async () => {
        const summary = { purged: 1, embedded: 0, reembedded: 0, embedStoppedReason: null };
        const sweep = jest.fn().mockResolvedValue(summary);
        await expect(runMemoryFactGcJob({ sweep })).resolves.toBe(summary);
        expect(sweep).toHaveBeenCalledTimes(1);
    });
});

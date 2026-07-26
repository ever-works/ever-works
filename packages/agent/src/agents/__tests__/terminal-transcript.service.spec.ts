import { TerminalTranscriptService } from '../terminal-transcript.service';
import { ENTITLEMENT_KEYS } from '../../subscriptions/credits/entitlements.service';

/**
 * Streaming-terminal M9 / founder decision D1.
 *
 * Pins the three promises the decision made: transcripts are PERSISTED
 * server-side, REDACTED before storage, and RETENTION-CAPPED by plan
 * tier ("forever" on top plans, bounded windows on cheap ones).
 *
 * Hand-rolled collaborators (no Nest testing module) — same style as the
 * sibling agent-run specs.
 */

const RUN = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
const USER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

type Chunks = {
    appendMany: jest.Mock;
    listByRun: jest.Mock;
    countByRun: jest.Mock;
    findRunIdsWithChunksOlderThan: jest.Mock;
    deleteOlderThanForRun: jest.Mock;
    deleteForRuns: jest.Mock;
};

function makeChunks(): Chunks {
    return {
        appendMany: jest.fn().mockResolvedValue(0),
        listByRun: jest.fn().mockResolvedValue([]),
        countByRun: jest.fn().mockResolvedValue(0),
        findRunIdsWithChunksOlderThan: jest.fn().mockResolvedValue([]),
        deleteOlderThanForRun: jest.fn().mockResolvedValue(0),
        deleteForRuns: jest.fn().mockResolvedValue(0),
    };
}

function makeService(opts: { planCode?: string; retentionDays?: number } = {}) {
    const chunks = makeChunks();
    const runs = { findById: jest.fn().mockResolvedValue({ id: RUN, userId: USER }) };
    const users = {
        findByIdForScheduledRun: jest
            .fn()
            .mockResolvedValue({ id: USER, defaultPlan: { code: opts.planCode ?? 'standard' } }),
    };
    const entitlements = {
        getNumber: jest.fn().mockResolvedValue(opts.retentionDays ?? 30),
    };
    const service = new TerminalTranscriptService(
        chunks as never,
        runs as never,
        users as never,
        entitlements as never,
    );
    return { service, chunks, runs, users, entitlements };
}

const ENV_KEYS = [
    'TERMINAL_TRANSCRIPT_PERSISTENCE',
    'TERMINAL_TRANSCRIPT_RETENTION_DAYS',
    'TERMINAL_TRANSCRIPT_REPLAY_MAX_CHUNKS',
    'TERMINAL_TRANSCRIPT_REPLAY_MAX_CHARS',
] as const;

describe('TerminalTranscriptService', () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of ENV_KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    describe('persistFrames — the publish path', () => {
        it('writes stdout frames as decoded, seq-keyed chunks', async () => {
            const { service, chunks } = makeService();

            const written = await service.persistFrames(RUN, [
                { kind: 'stdout', seq: 0, data: b64('hello ') },
                { kind: 'stdout', seq: 1, data: b64('world\n') },
            ] as never);

            expect(written).toBe(2);
            expect(chunks.appendMany).toHaveBeenCalledTimes(1);
            expect(chunks.appendMany.mock.calls[0][0]).toEqual([
                { runId: RUN, seq: 0, direction: 'out', text: 'hello ', byteLength: 6 },
                { runId: RUN, seq: 1, direction: 'out', text: 'world\n', byteLength: 6 },
            ]);
        });

        it('REDACTS credential-shaped output before it reaches storage', async () => {
            const { service, chunks } = makeService();
            const token = `ghp_${'a'.repeat(40)}`;

            await service.persistFrames(RUN, [
                { kind: 'stdout', seq: 0, data: b64(`gh auth login --with-token ${token}\n`) },
                { kind: 'stdout', seq: 1, data: b64('export DEPLOY_SECRET=opaquevalue123\n') },
            ] as never);

            const stored = chunks.appendMany.mock.calls[0][0] as Array<{ text: string }>;
            const all = stored.map((c) => c.text).join('');
            expect(all).not.toContain(token);
            expect(all).not.toContain('opaquevalue123');
            expect(all).toContain('[redacted secret]');
        });

        it('stores the PRE-redaction byte length for retention accounting', async () => {
            const { service, chunks } = makeService();
            const raw = 'export DEPLOY_SECRET=opaquevalue123\n';

            await service.persistFrames(RUN, [{ kind: 'stdout', seq: 4, data: b64(raw) }] as never);

            const stored = chunks.appendMany.mock.calls[0][0][0];
            expect(stored.byteLength).toBe(Buffer.byteLength(raw, 'utf8'));
            expect(stored.text.length).not.toBe(raw.length);
        });

        it('ignores non-stdout frames (exit / error / stdin carry no transcript)', async () => {
            const { service, chunks } = makeService();

            const written = await service.persistFrames(RUN, [
                { kind: 'exit', code: 0, reason: 'completed' },
                { kind: 'error', message: 'provider not configured' },
                { kind: 'stdin', data: b64('ls') },
            ] as never);

            expect(written).toBe(0);
            expect(chunks.appendMany).not.toHaveBeenCalled();
        });

        it('de-duplicates a repeated seq inside a single batch', async () => {
            const { service, chunks } = makeService();

            const written = await service.persistFrames(RUN, [
                { kind: 'stdout', seq: 7, data: b64('a') },
                { kind: 'stdout', seq: 7, data: b64('a') },
            ] as never);

            expect(written).toBe(1);
            expect(chunks.appendMany.mock.calls[0][0]).toHaveLength(1);
        });

        it('RETENTION 0 (cheap plan) writes NOTHING — no row to sweep later', async () => {
            const { service, chunks, entitlements } = makeService({
                planCode: 'free',
                retentionDays: 0,
            });

            const written = await service.persistFrames(RUN, [
                { kind: 'stdout', seq: 0, data: b64('secret work') },
            ] as never);

            expect(written).toBe(0);
            expect(chunks.appendMany).not.toHaveBeenCalled();
            expect(entitlements.getNumber).toHaveBeenCalledWith(
                'free',
                ENTITLEMENT_KEYS.TERMINAL_TRANSCRIPT_RETENTION_DAYS,
                expect.any(Number),
            );
        });

        it('RETENTION -1 (top plan, forever) persists normally', async () => {
            const { service, chunks } = makeService({ planCode: 'premium', retentionDays: -1 });

            await service.persistFrames(RUN, [
                { kind: 'stdout', seq: 0, data: b64('kept forever') },
            ] as never);

            expect(chunks.appendMany).toHaveBeenCalledTimes(1);
        });

        it('is BEST-EFFORT: a storage failure never propagates to the session', async () => {
            const { service, chunks } = makeService();
            chunks.appendMany.mockRejectedValue(new Error('db down'));

            await expect(
                service.persistFrames(RUN, [{ kind: 'stdout', seq: 0, data: b64('x') }] as never),
            ).resolves.toBe(0);
        });

        it('respects the persistence kill switch', async () => {
            process.env.TERMINAL_TRANSCRIPT_PERSISTENCE = 'off';
            const { service, chunks } = makeService();

            const written = await service.persistFrames(RUN, [
                { kind: 'stdout', seq: 0, data: b64('x') },
            ] as never);

            expect(written).toBe(0);
            expect(chunks.appendMany).not.toHaveBeenCalled();
        });

        it('memoizes the plan lookup across batches of the same run', async () => {
            const { service, users } = makeService();

            await service.persistFrames(RUN, [{ kind: 'stdout', seq: 0, data: b64('a') }] as never);
            await service.persistFrames(RUN, [{ kind: 'stdout', seq: 1, data: b64('b') }] as never);

            expect(users.findByIdForScheduledRun).toHaveBeenCalledTimes(1);
        });
    });

    describe('resolveRetentionDays', () => {
        it('falls back (fail-closed, 0) when the run has no resolvable plan', async () => {
            const { service, runs } = makeService();
            runs.findById.mockResolvedValue(null);

            await expect(service.resolveRetentionDays(RUN)).resolves.toBe(0);
        });

        it('honours the operator fallback for a plan code with no entitlement row', async () => {
            process.env.TERMINAL_TRANSCRIPT_RETENTION_DAYS = '7';
            const { service, entitlements } = makeService({ planCode: 'custom' });
            // The service passes the fallback down; a missing row means the
            // entitlement service hands it straight back.
            entitlements.getNumber.mockImplementation(
                async (_plan: string, _key: string, fallback: number) => fallback,
            );

            await expect(service.resolveRetentionDays(RUN)).resolves.toBe(7);
        });
    });

    describe('getTranscriptPage — replay', () => {
        const row = (seq: number, text: string) => ({
            seq,
            direction: 'out' as const,
            text,
            createdAt: new Date('2026-07-25T00:00:00.000Z'),
        });

        it('returns chunks oldest-first with lastSeq and total', async () => {
            const { service, chunks } = makeService();
            chunks.listByRun.mockResolvedValue([row(0, 'a'), row(1, 'b')]);
            chunks.countByRun.mockResolvedValue(2);

            const page = await service.getTranscriptPage(RUN);

            expect(page.chunks.map((c) => c.seq)).toEqual([0, 1]);
            expect(page.lastSeq).toBe(1);
            expect(page.total).toBe(2);
            expect(page.hasMore).toBe(false);
        });

        it('paginates from fromSeq and clamps limit to the configured cap', async () => {
            process.env.TERMINAL_TRANSCRIPT_REPLAY_MAX_CHUNKS = '2';
            const { service, chunks } = makeService();
            chunks.listByRun.mockResolvedValue([row(5, 'a'), row(6, 'b'), row(7, 'c')]);

            const page = await service.getTranscriptPage(RUN, { fromSeq: 5, limit: 9999 });

            // limit clamped to 2 → the repository was asked for limit+1.
            expect(chunks.listByRun).toHaveBeenCalledWith(RUN, 5, 3);
            expect(page.chunks).toHaveLength(2);
            expect(page.hasMore).toBe(true);
            expect(page.lastSeq).toBe(6);
        });

        it('caps a page by TOTAL CHARACTERS, not just chunk count', async () => {
            process.env.TERMINAL_TRANSCRIPT_REPLAY_MAX_CHARS = '10';
            const { service, chunks } = makeService();
            chunks.listByRun.mockResolvedValue([row(0, 'x'.repeat(8)), row(1, 'y'.repeat(8))]);

            const page = await service.getTranscriptPage(RUN);

            expect(page.chunks).toHaveLength(1);
            expect(page.hasMore).toBe(true);
        });

        it('rejects a garbage fromSeq/limit rather than propagating NaN', async () => {
            const { service, chunks } = makeService();

            await service.getTranscriptPage(RUN, {
                fromSeq: Number.NaN,
                limit: -5,
            } as never);

            const [, fromSeq, limit] = chunks.listByRun.mock.calls[0];
            expect(fromSeq).toBe(0);
            expect(Number.isSafeInteger(limit)).toBe(true);
            expect(limit).toBeGreaterThan(0);
        });

        it('returns an empty page for a run with no transcript', async () => {
            const { service } = makeService();

            const page = await service.getTranscriptPage(RUN);

            expect(page).toMatchObject({ chunks: [], lastSeq: null, hasMore: false, total: 0 });
        });
    });

    describe('sweepExpired — retention as a plan-tier lever', () => {
        it('SKIPS runs on a forever plan (-1)', async () => {
            const { service, chunks } = makeService({ planCode: 'premium', retentionDays: -1 });
            chunks.findRunIdsWithChunksOlderThan.mockResolvedValue([RUN]);

            const summary = await service.sweepExpired();

            expect(summary.keptForever).toBe(1);
            expect(chunks.deleteOlderThanForRun).not.toHaveBeenCalled();
        });

        it('deletes EVERYTHING for a run whose plan retains 0 days', async () => {
            const now = new Date('2026-07-25T12:00:00.000Z');
            const { service, chunks } = makeService({ planCode: 'free', retentionDays: 0 });
            chunks.findRunIdsWithChunksOlderThan.mockResolvedValue([RUN]);
            chunks.deleteOlderThanForRun.mockResolvedValue(9);

            const summary = await service.sweepExpired(now);

            expect(chunks.deleteOlderThanForRun).toHaveBeenCalledWith(RUN, now);
            expect(summary.deletedChunks).toBe(9);
            expect(summary.prunedRuns).toBe(1);
        });

        it('prunes past an N-day window with the cutoff N days back', async () => {
            const now = new Date('2026-07-25T12:00:00.000Z');
            const { service, chunks } = makeService({ planCode: 'standard', retentionDays: 30 });
            chunks.findRunIdsWithChunksOlderThan.mockResolvedValue([RUN]);
            chunks.deleteOlderThanForRun.mockResolvedValue(3);

            await service.sweepExpired(now);

            const cutoff = chunks.deleteOlderThanForRun.mock.calls[0][1] as Date;
            const days = (now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
            expect(days).toBeCloseTo(30, 5);
        });

        it('never deletes when the tier lookup fails', async () => {
            const { service, chunks, runs } = makeService();
            chunks.findRunIdsWithChunksOlderThan.mockResolvedValue([RUN]);
            runs.findById.mockRejectedValue(new Error('db down'));

            const summary = await service.sweepExpired();

            expect(chunks.deleteOlderThanForRun).not.toHaveBeenCalled();
            expect(summary.deletedChunks).toBe(0);
            expect(summary.scannedRuns).toBe(1);
        });
    });
});

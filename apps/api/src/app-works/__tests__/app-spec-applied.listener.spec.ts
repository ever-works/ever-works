import 'reflect-metadata';
import { AppSpecAppliedUpstreamListener } from '../app-spec-applied.listener';

/**
 * APW-02 T49 (FR-64, ACC-02-28) — `app.spec.applied` recomputes the upstream schedule
 * for an `upstreamSync` or `source` change, and leaves the row alone for any other block.
 */
const WORK_ID = '22222222-2222-4222-8222-222222222201';
const NOW = new Date('2026-10-27T00:00:00.000Z');

function build(
    options: { row?: Record<string, unknown> | null; spec?: Record<string, unknown> | null } = {},
) {
    const row =
        options.row === undefined
            ? {
                  workId: WORK_ID,
                  relation: 'fork',
                  readinessState: 'ready',
                  upstreamStatus: 'available',
                  dataRepositoryStatus: 'available',
                  lastSyncResult: null,
              }
            : options.row;
    const rows = {
        findByWorkId: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(true),
    };
    const specs = {
        getEffectiveSpec: jest.fn().mockResolvedValue({
            status: 'valid',
            spec: options.spec === undefined ? { upstreamSync: { schedule: '0 3 * * *' } } : options.spec,
        }),
    };
    const listener = new AppSpecAppliedUpstreamListener(rows as never, specs as never);
    return { listener, rows, specs };
}

describe('AppSpecAppliedUpstreamListener (APW-02 T49)', () => {
    it.each(['upstreamSync', 'source'])('recomputes the schedule and next slot on a %s change', async (block) => {
        const h = build();

        const outcome = await h.listener.onSpecApplied({ workId: WORK_ID, changedBlocks: [block] }, NOW);

        expect(outcome.reason).toBe('recomputed');
        expect(h.rows.update).toHaveBeenCalledTimes(1);
        const [, patch] = h.rows.update.mock.calls[0];
        expect(patch.syncSchedule).toBe('0 3 * * *');
        expect(patch.nextSyncAt).toBeInstanceOf(Date);
        expect((patch.nextSyncAt as Date).getTime()).toBeGreaterThan(NOW.getTime());
    });

    it('leaves the row alone for any other block', async () => {
        const h = build();

        const outcome = await h.listener.onSpecApplied(
            { workId: WORK_ID, changedBlocks: ['build', 'env', 'components'] },
            NOW,
        );

        expect(outcome.reason).toBe('unrelated_blocks');
        expect(h.specs.getEffectiveSpec).not.toHaveBeenCalled();
        expect(h.rows.update).not.toHaveBeenCalled();
    });

    it('clears the next slot when the spec turns the scheduled sync off', async () => {
        const h = build({ spec: { upstreamSync: { enabled: false } } });

        await h.listener.onSpecApplied({ workId: WORK_ID, changedBlocks: ['upstreamSync'] }, NOW);

        expect(h.rows.update.mock.calls[0][1]).toMatchObject({ nextSyncAt: null });
    });

    it('writes the schedule only for a paused or not-ready row', async () => {
        for (const row of [
            { workId: WORK_ID, relation: 'fork', readinessState: 'ready', upstreamStatus: 'archived' },
            { workId: WORK_ID, relation: 'fork', readinessState: 'preparing', upstreamStatus: 'available' },
        ]) {
            const h = build({ row });

            const outcome = await h.listener.onSpecApplied(
                { workId: WORK_ID, changedBlocks: ['upstreamSync'] },
                NOW,
            );

            expect(outcome.reason).toBe('schedule_only');
            expect(h.rows.update.mock.calls[0][1]).toEqual({ syncSchedule: '0 3 * * *' });
        }
    });

    it('never touches a link, a Work with no state row, or an event with no Work', async () => {
        const link = build({ row: { workId: WORK_ID, relation: 'link' } });
        const none = build({ row: null });
        const empty = build();

        expect((await link.listener.onSpecApplied({ workId: WORK_ID, changedBlocks: ['source'] })).reason).toBe(
            'link',
        );
        expect((await none.listener.onSpecApplied({ workId: WORK_ID, changedBlocks: ['source'] })).reason).toBe(
            'no_state',
        );
        expect((await empty.listener.onSpecApplied({ workId: '', changedBlocks: ['source'] })).reason).toBe(
            'no_work',
        );
        for (const h of [link, none, empty]) expect(h.rows.update).not.toHaveBeenCalled();
    });

    it('never throws: a failing read is logged and answered', async () => {
        const h = build();
        h.rows.findByWorkId.mockRejectedValue(new Error('db down'));

        await expect(
            h.listener.onSpecApplied({ workId: WORK_ID, changedBlocks: ['upstreamSync'] }),
        ).resolves.toMatchObject({ reason: 'failed' });
    });

    it('subscribes to app.spec.applied', () => {
        const metadata = Reflect.getMetadata(
            'EVENT_LISTENER_METADATA',
            AppSpecAppliedUpstreamListener.prototype.onSpecApplied,
        ) as Array<{ event: string }> | undefined;
        expect(metadata?.map((entry) => entry.event)).toContain('app.spec.applied');
    });
});

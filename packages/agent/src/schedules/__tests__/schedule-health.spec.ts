import {
    evaluateScheduleHealth,
    proposeScheduleRepair,
    repairClassFor,
    ScheduleHealthService,
    type ScheduleHealthInput,
} from '../schedule-health.service';

const NOW = new Date('2026-09-14T10:00:00.000Z');

function input(over: Partial<ScheduleHealthInput> = {}): ScheduleHealthInput {
    return {
        sourceType: 'recurring_task',
        cadenceKind: 'cron',
        cadence: '0 7 * * *',
        paused: false,
        requiresAgent: true,
        agentResolved: true,
        now: NOW,
        ...over,
    };
}

describe('evaluateScheduleHealth — NEVER RUNS means unsatisfiable, not infrequent', () => {
    it('a healthy daily cadence with an Agent is OK', () => {
        const health = evaluateScheduleHealth(input());
        expect(health).toEqual({
            ok: true,
            reason: null,
            reasonKey: null,
            repair: 'none',
            checkedAt: NOW.toISOString(),
        });
    });

    describe('each of the seven reasons comes from its own fixture', () => {
        it.each<[string, Partial<ScheduleHealthInput>, string]>([
            ['impossible-date', { cadence: '0 18 30 2 *' }, 'impossibleDate'],
            ['ended', { endsAt: new Date('2026-06-30T00:00:00.000Z') }, 'ended'],
            ['exhausted', { maxOccurrences: 3, occurredCount: 3 }, 'exhausted'],
            [
                'past-one-shot',
                { oneShotAt: new Date('2026-08-03T14:00:00.000Z'), oneShotClaimed: false },
                'pastOneShot',
            ],
            ['unparseable', { cadence: '*/0 * * * *' }, 'unparseable'],
            ['no-agent', { agentResolved: false }, 'noAgent'],
            ['owner-archived', { ownerArchived: true }, 'ownerArchived'],
        ])('%s', (reason, over, reasonKey) => {
            const health = evaluateScheduleHealth(input(over));
            expect(health.ok).toBe(false);
            expect(health.reason).toBe(reason);
            expect(health.reasonKey).toBe(reasonKey);
            expect(health.repair).toBe(repairClassFor(health.reason!));
        });
    });

    it('declares the repair class of every reason (FR-45)', () => {
        expect(repairClassFor('impossible-date')).toBe('automatic');
        expect(repairClassFor('ended')).toBe('automatic');
        expect(repairClassFor('exhausted')).toBe('automatic');
        expect(repairClassFor('past-one-shot')).toBe('automatic');
        expect(repairClassFor('no-agent')).toBe('choice');
        expect(repairClassFor('owner-archived')).toBe('choice');
        expect(repairClassFor('unparseable')).toBe('none');
    });

    it('does NOT flag a yearly cadence', () => {
        expect(evaluateScheduleHealth(input({ cadence: '0 9 1 1 *' })).ok).toBe(true);
    });

    it('does NOT flag a 29-February cadence (it exists in leap years)', () => {
        expect(evaluateScheduleHealth(input({ cadence: '0 9 29 2 *' })).ok).toBe(true);
    });

    it('does NOT flag day 31 when at least one named month has 31 days', () => {
        expect(evaluateScheduleHealth(input({ cadence: '0 9 31 4,5 *' })).ok).toBe(true);
    });

    it('does NOT flag a day-of-month that a restricted weekday rescues (OR semantics)', () => {
        expect(evaluateScheduleHealth(input({ cadence: '0 9 30 2 MON' })).ok).toBe(true);
    });

    it('flags an RRULE that names an impossible date', () => {
        const health = evaluateScheduleHealth(
            input({ cadenceKind: 'rrule', cadence: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30' }),
        );
        expect(health.reason).toBe('impossible-date');
    });

    it('flags an RRULE whose UNTIL has passed as ended', () => {
        const health = evaluateScheduleHealth(
            input({ cadenceKind: 'rrule', cadence: 'FREQ=WEEKLY;UNTIL=20260630T000000Z' }),
        );
        expect(health.reason).toBe('ended');
    });

    it('flags an unreadable RRULE and a missing cron as unparseable', () => {
        expect(
            evaluateScheduleHealth(input({ cadenceKind: 'rrule', cadence: 'GARBAGE' })).reason,
        ).toBe('unparseable');
        expect(evaluateScheduleHealth(input({ cadence: null })).reason).toBe('unparseable');
    });

    it('never flags a PAUSED Schedule, whatever is wrong with it (FR-41)', () => {
        expect(
            evaluateScheduleHealth(
                input({ paused: true, cadence: '0 18 30 2 *', agentResolved: false }),
            ).ok,
        ).toBe(true);
    });

    it('never flags a Mission tick whose Mission was completed — that row is Ended', () => {
        expect(
            evaluateScheduleHealth(
                input({
                    sourceType: 'mission_tick',
                    ownerCompleted: true,
                    requiresAgent: false,
                    cadence: '*/0 * * * *',
                }),
            ).ok,
        ).toBe(true);
    });

    it('ignores the Agent requirement for sources that do not need one', () => {
        expect(
            evaluateScheduleHealth(
                input({
                    sourceType: 'inbound_trigger',
                    cadenceKind: 'event',
                    cadence: null,
                    requiresAgent: false,
                }),
            ).ok,
        ).toBe(true);
    });

    it('reports exactly one reason when several apply (fixed precedence)', () => {
        const health = evaluateScheduleHealth(
            input({
                ownerArchived: true,
                cadence: '0 18 30 2 *',
                endsAt: new Date('2026-01-01T00:00:00.000Z'),
                agentResolved: false,
            }),
        );
        expect(health.reason).toBe('owner-archived');
    });

    it('a future one-shot and a claimed past one-shot are both fine', () => {
        expect(
            evaluateScheduleHealth(input({ oneShotAt: new Date('2026-09-20T00:00:00.000Z') })).ok,
        ).toBe(true);
        expect(
            evaluateScheduleHealth(
                input({ oneShotAt: new Date('2026-08-01T00:00:00.000Z'), oneShotClaimed: true }),
            ).ok,
        ).toBe(true);
    });
});

describe('proposeScheduleRepair — preview only, before and after', () => {
    it('clamps a February day-of-month to 28', () => {
        const health = evaluateScheduleHealth(input({ cadence: '0 18 30 2 *' }));
        const proposal = proposeScheduleRepair({
            health,
            cadenceKind: 'cron',
            cadence: '0 18 30 2 *',
            now: NOW,
        });
        expect(proposal).toMatchObject({
            repair: 'automatic',
            before: '0 18 30 2 *',
            after: '0 18 28 2 *',
        });
        expect(proposal.beforeHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('clamps an RRULE day to the shortest named month', () => {
        const cadence = 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30';
        const proposal = proposeScheduleRepair({
            health: evaluateScheduleHealth(input({ cadenceKind: 'rrule', cadence })),
            cadenceKind: 'rrule',
            cadence,
            now: NOW,
        });
        expect(proposal.after).toBe('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=28');
    });

    it('describes clearing an end date and an occurrence cap by key, not prose', () => {
        const endsAt = new Date('2026-06-30T00:00:00.000Z');
        const ended = proposeScheduleRepair({
            health: evaluateScheduleHealth(input({ endsAt })),
            cadenceKind: 'cron',
            cadence: '0 8 * * 1',
            endsAt,
            now: NOW,
        });
        expect(ended).toMatchObject({
            before: endsAt.toISOString(),
            after: null,
            afterKey: 'clearEndDate',
        });

        const exhausted = proposeScheduleRepair({
            health: evaluateScheduleHealth(input({ maxOccurrences: 3, occurredCount: 3 })),
            cadenceKind: 'cron',
            cadence: '0 8 * * 1',
            maxOccurrences: 3,
            now: NOW,
        });
        expect(exhausted).toMatchObject({
            before: '3',
            after: null,
            afterKey: 'clearOccurrenceCap',
        });
    });

    it('moves a past one-shot to the same time of day, at least 5 minutes ahead', () => {
        const oneShotAt = new Date('2026-08-03T10:03:00.000Z');
        const proposal = proposeScheduleRepair({
            health: evaluateScheduleHealth(input({ oneShotAt })),
            cadenceKind: 'cron',
            cadence: '0 7 * * *',
            oneShotAt,
            now: NOW,
        });
        // 10:03 today is only 3 minutes ahead of 10:00 — so tomorrow.
        expect(proposal.after).toBe('2026-09-15T10:03:00.000Z');
    });

    it('offers no `after` for a choice or a none repair', () => {
        const noAgent = proposeScheduleRepair({
            health: evaluateScheduleHealth(input({ agentResolved: false })),
            cadenceKind: 'cron',
            cadence: '0 7 * * *',
            now: NOW,
        });
        expect(noAgent).toMatchObject({ repair: 'choice', after: null });
        const unparseable = proposeScheduleRepair({
            health: evaluateScheduleHealth(input({ cadence: '*/0 * * * *' })),
            cadenceKind: 'cron',
            cadence: '*/0 * * * *',
            now: NOW,
        });
        expect(unparseable).toMatchObject({ repair: 'none', after: null });
    });

    it('fingerprints the before-state so a changed Schedule gets a different hash', () => {
        const health = evaluateScheduleHealth(input({ cadence: '0 18 30 2 *' }));
        const a = proposeScheduleRepair({
            health,
            cadenceKind: 'cron',
            cadence: '0 18 30 2 *',
            now: NOW,
        });
        const b = proposeScheduleRepair({
            health,
            cadenceKind: 'cron',
            cadence: '0 18 31 2 *',
            now: NOW,
        });
        expect(a.beforeHash).not.toEqual(b.beforeHash);
    });

    it('proposes nothing for a healthy Schedule', () => {
        expect(
            proposeScheduleRepair({
                health: evaluateScheduleHealth(input()),
                cadenceKind: 'cron',
                cadence: '0 7 * * *',
                now: NOW,
            }),
        ).toEqual({ repair: 'none', before: null, after: null, beforeHash: null });
    });

    it('is exposed through the injectable service unchanged', () => {
        const service = new ScheduleHealthService();
        expect(service.evaluate(input({ agentResolved: false })).reason).toBe('no-agent');
    });
});

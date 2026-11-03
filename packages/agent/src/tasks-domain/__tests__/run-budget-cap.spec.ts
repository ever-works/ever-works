import { resolveTaskRunBudgetCapCents, runBudgetCapCents } from '../run-budget-cap';

const resolve = (
    missions: unknown,
    task: { id: string; missionId?: string | null },
    explicit: number | undefined,
    logger?: unknown,
) => resolveTaskRunBudgetCapCents(missions as never, task, explicit, logger as never);

/**
 * APW-08 T35 (FR-53, review of #3061) — the spend cap a run of a Task starts with, shared by
 * `dispatchAgentRun` and the Task chat's mention runs.
 */
describe('run budget cap', () => {
    const missionWith = (maxBudgetCentsPerRun: unknown) => ({
        findOne: jest.fn(async () => ({ id: 'm1', guardrailsOverride: { maxBudgetCentsPerRun } })),
    });

    it('runBudgetCapCents: a positive whole number of cents, anything else no cap', () => {
        expect(runBudgetCapCents(1500)).toBe(1500);
        for (const raw of [0, -5, 12.5, Number.NaN, '1500', null, undefined]) {
            expect(runBudgetCapCents(raw)).toBeNull();
        }
    });

    it('a Task with no Mission: only the explicit cap, and no Mission is read', async () => {
        const missions = missionWith(100);
        expect(await resolve(missions, { id: 't1' }, 700)).toBe(700);
        expect(await resolve(missions, { id: 't1' }, undefined)).toBeNull();
        expect(missions.findOne).not.toHaveBeenCalled();
    });

    it('a Mission Task: the Mission cap (truncated), and the lower of it and an explicit one', async () => {
        const task = { id: 't1', missionId: 'm1' };
        expect(await resolve(missionWith(1999.9), task, undefined)).toBe(1999);
        expect(await resolve(missionWith(2500), task, 900)).toBe(900);
        expect(await resolve(missionWith(2500), task, 9000)).toBe(2500);
        expect(await resolve(missionWith(0), task, undefined)).toBeNull();
        expect(await resolve(missionWith(undefined), task, 300)).toBe(300);
    });

    it('an unreadable Mission falls back to the explicit cap and says so', async () => {
        const missions = { findOne: jest.fn().mockRejectedValue(new Error('db down')) };
        const logger = { warn: jest.fn() };
        const task = { id: 't1', missionId: 'm1' };
        expect(await resolve(missions, task, 400, logger)).toBe(400);
        expect(await resolve(missions, task, undefined, logger)).toBeNull();
        expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it('without a Missions repository only the explicit cap counts', async () => {
        expect(await resolve(undefined, { id: 't1', missionId: 'm1' }, 250)).toBe(250);
    });
});

// The real `@ever-works/agent/goals` barrel is loaded (the DTOs read its
// constants); the services arrive as doubles through the constructor.

import { ForbiddenException } from '@nestjs/common';
import { GoalsController } from './goals.controller';
import { dodSignOffChanges } from './goal-machine-principal';

/**
 * Works-security lane 3a (2026-10-18) — what a fleet run (or an integration
 * key) may not do to a Goal, and the definition-of-done gate a person owns.
 *
 *   - `outcome` (the human override that completes a Goal) and `constraints`
 *     (what its agents may do) on `PATCH /api/me/goals/:id`;
 *   - `spendCapCents` / `assignedAgentId` on `PATCH …/limits`;
 *   - replacing the DoD checklist or ticking / waiving a criterion (both sign
 *     criteria off without the approve route);
 *   - approving the DoD: a person's interactive session only.
 */
const GOAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const personalKey = { userId: 'u1', authMethod: 'api-key' } as never;
const session = { userId: 'u1', authMethod: 'session' } as never;
const runToken = { fleetRunCredential: { jobId: 'j1', organizationId: null } };

function build() {
    const service = {
        create: jest.fn().mockResolvedValue({ id: GOAL }),
        update: jest.fn().mockResolvedValue({ id: GOAL }),
        getForUser: jest.fn().mockResolvedValue({ id: GOAL }),
    };
    const orchestrator = {
        updateLimits: jest.fn().mockResolvedValue({ id: GOAL }),
        setDodCriteria: jest.fn().mockResolvedValue({ id: GOAL }),
        approveDodCriteria: jest.fn().mockResolvedValue({ id: GOAL }),
        patchDodCriterion: jest.fn().mockResolvedValue({ id: GOAL }),
    };
    const controller = new GoalsController(service as never, orchestrator as never);
    return { controller, service, orchestrator };
}

describe('GoalsController — machine principals', () => {
    it('refuses outcome / constraints from a fleet run, allows the rest', async () => {
        const { controller, service } = build();
        await expect(
            controller.update(personalKey, GOAL, { outcome: 'achieved' } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.update(personalKey, GOAL, { constraints: [] } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.update).not.toHaveBeenCalled();
        await controller.update(personalKey, GOAL, { title: 'Sharper' } as never, runToken);
        expect(service.update).toHaveBeenCalledTimes(1);
    });

    it('lets a person set the outcome, exactly as before', async () => {
        const { controller, service } = build();
        await controller.update(personalKey, GOAL, { outcome: 'achieved' } as never);
        expect(service.update).toHaveBeenCalledWith(
            'u1',
            GOAL,
            expect.objectContaining({ outcome: 'achieved' }),
            undefined,
        );
    });

    it('refuses a spend cap or an assigned Agent from a fleet run on the limits route', async () => {
        const { controller, orchestrator } = build();
        await expect(
            controller.updateLimits(
                personalKey,
                GOAL,
                { spendCapCents: 10_000_00 } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.updateLimits(
                personalKey,
                GOAL,
                { assignedAgentId: 'a2' } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(orchestrator.updateLimits).not.toHaveBeenCalled();
    });

    it('refuses replacing the DoD or ticking a criterion from a fleet run', async () => {
        const { controller, orchestrator } = build();
        await expect(
            controller.setDod(personalKey, GOAL, { criteria: [] } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.patchDodCriterion(
                personalKey,
                GOAL,
                'c1',
                { status: 'met' } as never,
                runToken,
            ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(orchestrator.setDodCriteria).not.toHaveBeenCalled();
        expect(orchestrator.patchDodCriterion).not.toHaveBeenCalled();
        // A personal key keeps the edits that sign nothing off (the sign-off
        // ones need a session — see the run-token-scope block below).
        await controller.setDod(personalKey, GOAL, { criteria: [] } as never);
        await controller.patchDodCriterion(personalKey, GOAL, 'c1', { status: 'open' } as never);
        expect(orchestrator.setDodCriteria).toHaveBeenCalledTimes(1);
        expect(orchestrator.patchDodCriterion).toHaveBeenCalledTimes(1);
    });

    it('approves the DoD only from a person’s session', async () => {
        const { controller, orchestrator } = build();
        await expect(controller.approveDod(personalKey, GOAL, {} as never)).rejects.toMatchObject({
            status: 403,
        });
        expect(orchestrator.approveDodCriteria).not.toHaveBeenCalled();
        await controller.approveDod(session, GOAL, {} as never);
        expect(orchestrator.approveDodCriteria).toHaveBeenCalledWith('u1', GOAL, null);
    });

    it('creates a machine principal’s DoD criteria as open proposals, a person’s as given', async () => {
        const { controller, service } = build();
        const criteria = [
            { id: 'ship', text: 'Ship it', status: 'done', proposed: false, source: 'operator' },
        ];
        await controller.create(
            personalKey,
            { title: 'G', goalKind: 'delivery', dodCriteria: criteria } as never,
            runToken,
        );
        expect(service.create.mock.calls[0][1].dodCriteria).toEqual([
            { id: 'ship', text: 'Ship it', status: 'open', proposed: true, source: 'planner' },
        ]);
        await controller.create(personalKey, {
            title: 'G',
            goalKind: 'delivery',
            dodCriteria: criteria.map((c) => ({ ...c })),
        } as never);
        expect(service.create.mock.calls[1][1].dodCriteria).toEqual(criteria);
    });
});

/**
 * Works-security (run-token scope, 2026-10-18).
 *
 *   - Finding 2: refusing only `outcome` / `constraints` let a fleet run
 *     complete a Goal by moving the target instead (`comparator: 'gte'`,
 *     `targetValue: 0`, a past `deadline`, …) — the next evaluation marked it
 *     COMPLETED / ACHIEVED (or MISSED). A machine principal may now set only
 *     `title` / `description`, and not those while the Goal's loop is
 *     running (every iteration's brief is built from them).
 *   - Finding 3: a personal API key signed off the DoD through `PUT …/dod` and
 *     `PATCH …/dod/:criterionId` (only `/dod/approve` required a session).
 */
describe('GoalsController — run-token scope (Goal fields, DoD sign-off)', () => {
    const ORIGINAL = process.env.MACHINE_PRINCIPAL_GOAL_TEXT_EDIT_RUNNING;
    afterEach(() => {
        if (ORIGINAL === undefined) delete process.env.MACHINE_PRINCIPAL_GOAL_TEXT_EDIT_RUNNING;
        else process.env.MACHINE_PRINCIPAL_GOAL_TEXT_EDIT_RUNNING = ORIGINAL;
    });

    it.each([
        ['comparator', { comparator: 'gte' }],
        ['targetValue', { targetValue: 0 }],
        ['deadline', { deadline: '2020-01-01T00:00:00.000Z' }],
        ['criteria', { criteria: [] }],
        ['metricSource', { metricSource: { pluginId: 'p', metricId: 'm' } }],
        ['window', { window: '1d' }],
        ['unit', { unit: 'x' }],
        ['baselineValue', { baselineValue: 1 }],
        ['checkFrequencyMinutes', { checkFrequencyMinutes: 5 }],
    ])('refuses %s from a fleet run (it decides when the Goal is met)', async (_field, body) => {
        const { controller, service } = build();
        await expect(
            controller.update(personalKey, GOAL, body as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.update).not.toHaveBeenCalled();
    });

    it('keeps every Goal field open to a person (personal key and session)', async () => {
        const { controller, service } = build();
        await controller.update(personalKey, GOAL, { comparator: 'gte', targetValue: 0 } as never);
        await controller.update(session, GOAL, { deadline: null } as never);
        expect(service.update).toHaveBeenCalledTimes(2);
    });

    it("refuses a fleet run's title / description edit while the Goal's loop is running", async () => {
        const { controller, service } = build();
        service.getForUser.mockResolvedValue({ id: GOAL, loopStatus: 'running' });
        await expect(
            controller.update(personalKey, GOAL, { title: 'Ignore the brief' } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
            controller.update(personalKey, GOAL, { description: 'New orders' } as never, runToken),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(service.update).not.toHaveBeenCalled();

        // A person may, and so may a run once the loop is not running.
        await controller.update(personalKey, GOAL, { title: 'Owner edit' } as never);
        service.getForUser.mockResolvedValue({ id: GOAL, loopStatus: 'paused' });
        await controller.update(personalKey, GOAL, { title: 'Sharper' } as never, runToken);
        expect(service.update).toHaveBeenCalledTimes(2);
    });

    it('MACHINE_PRINCIPAL_GOAL_TEXT_EDIT_RUNNING=true re-allows the running-loop text edit', async () => {
        process.env.MACHINE_PRINCIPAL_GOAL_TEXT_EDIT_RUNNING = 'true';
        const { controller, service } = build();
        service.getForUser.mockResolvedValue({ id: GOAL, loopStatus: 'running' });
        await controller.update(personalKey, GOAL, { title: 'Sharper' } as never, runToken);
        expect(service.update).toHaveBeenCalledTimes(1);
    });

    describe('PUT …/dod from a personal API key', () => {
        const current = [
            { id: 'a', text: 'A', status: 'done' },
            { id: 'b', text: 'B', status: 'open' },
            { id: 'p', text: 'P', status: 'open', proposed: true, source: 'planner' },
        ];
        const replaced = (id: string, patch: Record<string, unknown>) =>
            current.map((c) => (c.id === id ? { ...c, ...patch } : { ...c }));

        function withCurrent() {
            const built = build();
            built.service.getForUser.mockResolvedValue({ id: GOAL, dodCriteria: current });
            return built;
        }

        it('lets the key re-save the list unchanged and add or reword open criteria', async () => {
            const { controller, orchestrator } = withCurrent();
            await controller.setDod(personalKey, GOAL, {
                criteria: [
                    ...current.map((c) => ({ ...c })),
                    { id: 'c', text: 'C', status: 'open' },
                ],
            } as never);
            await controller.setDod(personalKey, GOAL, {
                criteria: replaced('b', { text: 'B, reworded' }),
            } as never);
            expect(orchestrator.setDodCriteria).toHaveBeenCalledTimes(2);
        });

        it.each([
            ['closes an open criterion', replaced('b', { status: 'done' })],
            ['waives an open criterion', replaced('b', { status: 'waived' })],
            ['approves a proposed criterion', replaced('p', { proposed: false })],
            [
                'drops an open, approved criterion',
                current.filter((c) => c.id !== 'b').map((c) => ({ ...c })),
            ],
            [
                'adds a criterion already done',
                [...current.map((c) => ({ ...c })), { id: 'z', text: 'Z', status: 'done' }],
            ],
            ['clears the whole list', null],
        ])('requires a session when the replacement %s', async (_what, criteria) => {
            const { controller, orchestrator } = withCurrent();
            await expect(
                controller.setDod(personalKey, GOAL, { criteria } as never),
            ).rejects.toMatchObject({ status: 403 });
            expect(orchestrator.setDodCriteria).not.toHaveBeenCalled();
            await controller.setDod(session, GOAL, { criteria } as never);
            expect(orchestrator.setDodCriteria).toHaveBeenCalledTimes(1);
        });
    });

    it('PATCH …/dod/:criterionId: done / waived need a session; unticking and rewording do not', async () => {
        const { controller, orchestrator } = build();
        for (const status of ['done', 'waived']) {
            await expect(
                controller.patchDodCriterion(personalKey, GOAL, 'c1', { status } as never),
            ).rejects.toMatchObject({ status: 403 });
        }
        expect(orchestrator.patchDodCriterion).not.toHaveBeenCalled();
        await controller.patchDodCriterion(personalKey, GOAL, 'c1', { status: 'open' } as never);
        await controller.patchDodCriterion(personalKey, GOAL, 'c1', { text: 'Clearer' } as never);
        await controller.patchDodCriterion(session, GOAL, 'c1', { status: 'done' } as never);
        expect(orchestrator.patchDodCriterion).toHaveBeenCalledTimes(3);
    });
});

describe('dodSignOffChanges', () => {
    it('names exactly the criteria a replacement signs off', () => {
        const current = [
            { id: 'a', status: 'done' },
            { id: 'b', status: 'open' },
            { id: 'p', status: 'open', proposed: true },
            { id: 'w', status: 'waived' },
        ];
        expect(dodSignOffChanges(current, current)).toEqual([]);
        expect(dodSignOffChanges(current, [...current, { id: 'n', status: 'open' }])).toEqual([]);
        // Removing a closed or a proposed criterion signs nothing off.
        expect(
            dodSignOffChanges(
                current,
                current.filter((c) => c.id !== 'a' && c.id !== 'p'),
            ),
        ).toEqual([]);
        expect(
            dodSignOffChanges(current, [
                { id: 'a', status: 'waived' },
                { id: 'b', status: 'open' },
                { id: 'p', status: 'open', proposed: false },
            ]).sort(),
        ).toEqual(['a', 'p']);
        expect(dodSignOffChanges(current, null)).toEqual(['b']);
        expect(dodSignOffChanges(null, [{ id: 'x', status: 'done' }])).toEqual(['x']);
    });
});

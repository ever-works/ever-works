// The real `@ever-works/agent/goals` barrel is loaded (the DTOs read its
// constants); the services arrive as doubles through the constructor.

import { ForbiddenException } from '@nestjs/common';
import { GoalsController } from './goals.controller';

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
        // A person (personal key) keeps both.
        await controller.setDod(personalKey, GOAL, { criteria: [] } as never);
        await controller.patchDodCriterion(personalKey, GOAL, 'c1', { status: 'met' } as never);
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

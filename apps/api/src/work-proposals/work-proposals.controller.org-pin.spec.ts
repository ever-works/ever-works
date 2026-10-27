// The controller is built with doubles below, so its service's module graph is never needed —
// and loading it reaches the API's NotificationsModule → AuthModule → the ESM-only `better-auth`,
// which this CJS Jest cannot parse (this spec, added in f2debe925, never loaded). Mocked the way
// `user-research.listener.spec.ts` mocks it.
jest.mock('./work-proposals.service', () => ({ WorkProposalsApiService: class {} }));

import { NotFoundException } from '@nestjs/common';
import { WorkProposalsController } from './work-proposals.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Works-security (run-token scope) — a fleet-run token reads and aims Ideas
 * only inside the Organization it was minted for (`null` = the owner's
 * personal scope). Before, `GET /api/me/work-proposals` (the `mine` view) and
 * `GET /api/me/work-proposals/:id` answered per USER, so a run in
 * Organization A read every Idea of the owner's other Organizations.
 */
describe('WorkProposalsController — fleet-run token Organization pin', () => {
    const ORIGINAL = process.env.FLEET_RUN_TOKEN_ORG_PIN_ENFORCED;
    const auth = { userId: 'u1', authMethod: 'api-key' } as AuthenticatedUser;
    const runReq = (organizationId: string | null) =>
        ({
            fleetRunCredential: { jobId: 'j1', nodeId: 'n1', runId: null, organizationId },
        }) as never;

    const idea = (id: string, organizationId: string | null) =>
        ({
            id,
            userId: 'u1',
            organizationId,
            title: `Idea ${id}`,
            description: 'd',
            status: 'pending',
        }) as never;

    let service: {
        list: jest.Mock;
        listVisible: jest.Mock;
        getReadable: jest.Mock;
        getForUser: jest.Mock;
        createUserManual: jest.Mock;
    };
    let budgets: { summarizeForOwner: jest.Mock };
    let works: { findByIdForAccess: jest.Mock };
    let controller: WorkProposalsController;

    beforeEach(() => {
        delete process.env.FLEET_RUN_TOKEN_ORG_PIN_ENFORCED;
        service = {
            list: jest.fn().mockResolvedValue([idea('a', 'org-a'), idea('b', 'org-b')]),
            listVisible: jest.fn().mockResolvedValue([idea('a', 'org-a'), idea('p', null)]),
            getReadable: jest.fn().mockResolvedValue(idea('b', 'org-b')),
            getForUser: jest.fn().mockResolvedValue(idea('b', 'org-b')),
            createUserManual: jest.fn().mockResolvedValue(idea('n', 'org-a')),
        };
        budgets = { summarizeForOwner: jest.fn().mockResolvedValue({}) };
        works = { findByIdForAccess: jest.fn().mockResolvedValue(null) };
        controller = new WorkProposalsController(
            service as never,
            budgets as never,
            undefined,
            works as never,
        );
    });

    afterAll(() => {
        if (ORIGINAL === undefined) delete process.env.FLEET_RUN_TOKEN_ORG_PIN_ENFORCED;
        else process.env.FLEET_RUN_TOKEN_ORG_PIN_ENFORCED = ORIGINAL;
    });

    it('narrows the `mine` query to the pinned Organization and filters the answer', async () => {
        const out = await controller.list(auth, {} as never, runReq('org-a'));
        expect(service.list).toHaveBeenCalledWith(
            'u1',
            expect.any(Array),
            expect.objectContaining({ organizationId: 'org-a' }),
        );
        expect(out.map((row) => row.id)).toEqual(['a']);
    });

    it('filters the shared / organization views too (a personal-scope run sees no Organization)', async () => {
        const out = await controller.list(auth, { view: 'organization' } as never, runReq(null));
        expect(out.map((row) => row.id)).toEqual(['p']);
    });

    it('answers 404 for an Idea of another Organization, on the read and the budget', async () => {
        await expect(controller.getOne(auth, 'b', runReq('org-a'))).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(controller.budget(auth, 'b', runReq('org-a'))).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(budgets.summarizeForOwner).not.toHaveBeenCalled();
    });

    it('refuses an Idea aimed at a Work of another Organization (or a missing one)', async () => {
        works.findByIdForAccess.mockResolvedValue({ id: 'w', organizationId: 'org-b' });
        await expect(
            controller.createUserManual(
                auth,
                { description: 'x', targetWorkId: 'w' } as never,
                runReq('org-a'),
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(service.createUserManual).not.toHaveBeenCalled();

        works.findByIdForAccess.mockResolvedValue({ id: 'w', organizationId: 'org-a' });
        await controller.createUserManual(
            auth,
            { description: 'x', targetWorkId: 'w' } as never,
            runReq('org-a'),
        );
        expect(service.createUserManual).toHaveBeenCalledTimes(1);
    });

    it('leaves every other credential, and a switched-off pin, exactly as before', async () => {
        const all = await controller.list(auth, {} as never, {} as never);
        expect(service.list).toHaveBeenLastCalledWith(
            'u1',
            expect.any(Array),
            expect.not.objectContaining({ organizationId: expect.anything() }),
        );
        expect(all.map((row) => row.id)).toEqual(['a', 'b']);
        await expect(controller.getOne(auth, 'b', {} as never)).resolves.toBeDefined();

        process.env.FLEET_RUN_TOKEN_ORG_PIN_ENFORCED = 'false';
        const off = await controller.list(auth, {} as never, runReq('org-a'));
        expect(off.map((row) => row.id)).toEqual(['a', 'b']);
        await expect(controller.getOne(auth, 'b', runReq('org-a'))).resolves.toBeDefined();
    });
});

// Stub the agent barrels so the spec never drags the entity / services graph in.
jest.mock('@ever-works/agent/database', () => ({
    UpstreamPullRequestRepository: class UpstreamPullRequestRepository {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));
jest.mock('@ever-works/agent/upstream-pull-requests', () => {
    const actual = jest.requireActual('@ever-works/contracts');
    return {
        UpstreamEligibilityService: class UpstreamEligibilityService {},
        UpstreamPullRequestRecordService: class UpstreamPullRequestRecordService {},
        // The real view mapping's contract: an explicit field list, no fingerprint / scope.
        toUpstreamPullRequestView: (row: Record<string, unknown>) => ({
            id: row.id,
            userId: row.userId,
            state: row.state,
            sourceTaskId: row.sourceTaskId ?? null,
            upstream: {
                owner: row.upstreamOwner,
                repo: row.upstreamRepo,
                baseBranch: row.baseBranch,
            },
            _contractsLoaded: Array.isArray(actual.UPSTREAM_PULL_REQUEST_STATES),
        }),
    };
});
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));

import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { UpstreamPullRequestsController } from './upstream-pull-requests.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * APW-09 T10 / T19 — `/api/works/:id/upstream-pull-requests[...]`.
 *
 * Every gate has a case that fails without it:
 *  - another account's (or an invisible) App Work is ONE `404 not_found` — a `403` from the
 *    ownership service is folded into it; a non-App Work is `422 notAppWork`;
 *  - the list and the eligibility read are scoped to the route's Work id, and eligibility needs
 *    EDIT access (a viewer never learns whether they could propose);
 *  - a record id is read through `findForWork(workId, prId)`: another Work's record is a `404`;
 *  - withdraw passes the owner flag from the access check, never from the body;
 *  - the extra-files acknowledgement refuses an API key / automation (`requireHumanSession`)
 *    before the service is called;
 *  - an invalid `state` filter is a `400`, never a silent "everything".
 */

const human = { userId: 'u1', authMethod: 'session' } as unknown as AuthenticatedUser;
const apiKey = { userId: 'u1', authMethod: 'api_key' } as unknown as AuthenticatedUser;

function build(
    options: {
        kind?: string;
        deny?: 'notFound' | 'forbidden';
        role?: string;
        creator?: boolean;
    } = {},
) {
    const work = {
        id: 'w1',
        userId: options.creator ? 'u1' : 'owner',
        kind: options.kind ?? 'app',
    };
    const refuse = () => {
        if (options.deny === 'notFound') throw new NotFoundException();
        if (options.deny === 'forbidden') throw new ForbiddenException();
        return {
            work,
            role: options.role ?? 'editor',
            member: null,
            isCreator: options.creator === true,
        };
    };
    const ownership = {
        ensureCanView: jest.fn(async () => refuse()),
        ensureCanEdit: jest.fn(async () => refuse()),
    };
    const row = {
        id: 'r1',
        workId: 'w1',
        userId: 'u1',
        state: 'awaiting_approval',
        upstreamOwner: 'acme',
        upstreamRepo: 'bookings',
        baseBranch: 'main',
        fingerprint: 'f'.repeat(64),
        checkResults: null,
        missingPieces: ['a'],
        claUrl: null,
    };
    const records = {
        listForWork: jest.fn(async () => ({ rows: [row], total: 1 })),
        findForWork: jest.fn(async (workId: string, id: string) =>
            workId === 'w1' && id === 'r1' ? row : null,
        ),
    };
    const writer = {
        withdraw: jest.fn(async () => ({ status: 'ok', row: { ...row, state: 'withdrawn' } })),
        acknowledgeExtraFiles: jest.fn(async () => ({ status: 'ok', row })),
    };
    const eligibility = {
        evaluate: jest.fn(async () => ({
            allowed: false,
            code: 'disabled',
            preparationAvailable: false,
        })),
    };
    const controller = new UpstreamPullRequestsController(
        ownership as never,
        records as never,
        writer as never,
        eligibility as never,
    );
    return { controller, ownership, records, writer, eligibility };
}

async function statusOf(
    promise: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof HttpException) {
            return {
                status: error.getStatus(),
                body: error.getResponse() as Record<string, unknown>,
            };
        }
        throw error;
    }
    return { status: 200, body: {} };
}

describe('UpstreamPullRequestsController (APW-09)', () => {
    describe('workspace scope', () => {
        it.each(['notFound', 'forbidden'] as const)(
            'answers one 404 not_found when the ownership check says %s — on every route',
            async (deny) => {
                const { controller, records, writer, eligibility } = build({ deny });
                for (const call of [
                    () => controller.list(human, 'w1'),
                    () => controller.getEligibility(human, 'w1'),
                    () => controller.getOne(human, 'w1', 'r1'),
                    () => controller.withdraw(human, 'w1', 'r1'),
                    () => controller.acknowledgeExtraFiles(human, 'w1', 'r1'),
                ]) {
                    const result = await statusOf(call());
                    expect(result.status).toBe(404);
                    expect(result.body).toMatchObject({ code: 'not_found' });
                }
                expect(records.listForWork).not.toHaveBeenCalled();
                expect(records.findForWork).not.toHaveBeenCalled();
                expect(writer.withdraw).not.toHaveBeenCalled();
                expect(eligibility.evaluate).not.toHaveBeenCalled();
            },
        );

        it('refuses a Work that is not an App Work with 422 notAppWork', async () => {
            const { controller } = build({ kind: 'directory' });
            const result = await statusOf(controller.list(human, 'w1'));
            expect(result).toMatchObject({ status: 422, body: { code: 'notAppWork' } });
        });

        it('reads with view access, and asks for EDIT access for eligibility and both writes', async () => {
            const { controller, ownership } = build();
            await controller.list(human, 'w1');
            await controller.getOne(human, 'w1', 'r1');
            expect(ownership.ensureCanView).toHaveBeenCalledTimes(2);
            expect(ownership.ensureCanEdit).not.toHaveBeenCalled();
            await controller.getEligibility(human, 'w1');
            await controller.withdraw(human, 'w1', 'r1');
            await controller.acknowledgeExtraFiles(human, 'w1', 'r1');
            expect(ownership.ensureCanEdit).toHaveBeenCalledTimes(3);
            for (const call of ownership.ensureCanEdit.mock.calls as unknown[][]) {
                expect(call).toEqual(['w1', 'u1']);
            }
        });
    });

    describe('reads', () => {
        it('lists the route Work’s records with their author, and no fingerprint', async () => {
            const { controller, records } = build();
            const result = await controller.list(human, 'w1', 'awaiting_approval', '5');
            expect(records.listForWork).toHaveBeenCalledWith('w1', {
                state: 'awaiting_approval',
                limit: 5,
            });
            expect(result.meta).toEqual({ total: 1 });
            expect(result.data[0]).toMatchObject({ id: 'r1', userId: 'u1' });
            expect(JSON.stringify(result)).not.toContain('f'.repeat(64));
        });

        it('refuses an unknown state filter with 400', async () => {
            const { controller, records } = build();
            const result = await statusOf(controller.list(human, 'w1', 'everything'));
            expect(result).toMatchObject({ status: 400, body: { code: 'invalidState' } });
            expect(records.listForWork).not.toHaveBeenCalled();
        });

        it('reads one record only through the route Work: another Work’s id is 404', async () => {
            const { controller, records } = build();
            const view = await controller.getOne(human, 'w1', 'r1');
            expect(view).toMatchObject({ id: 'r1', diff: null, missingPieces: ['a'] });
            expect(JSON.stringify(view)).not.toContain('f'.repeat(64));
            const missing = await statusOf(controller.getOne(human, 'w1', 'r-other'));
            expect(missing.status).toBe(404);
            expect(records.findForWork).toHaveBeenLastCalledWith('w1', 'r-other');
        });

        it('evaluates eligibility for the CALLER on the route Work, and 404s a foreign Task', async () => {
            const { controller, eligibility } = build();
            await expect(controller.getEligibility(human, 'w1', 't1')).resolves.toMatchObject({
                preparationAvailable: false,
            });
            expect(eligibility.evaluate).toHaveBeenCalledWith({
                workId: 'w1',
                userId: 'u1',
                taskId: 't1',
            });
            eligibility.evaluate.mockResolvedValueOnce({
                allowed: false,
                taskNotOnWork: true,
            } as never);
            const result = await statusOf(controller.getEligibility(human, 'w1', 't-other'));
            expect(result).toMatchObject({ status: 404, body: { code: 'taskNotOnWork' } });
        });
    });

    describe('writes', () => {
        it('withdraw passes the owner flag from the access check', async () => {
            const asMember = build();
            await asMember.controller.withdraw(human, 'w1', 'r1');
            expect(asMember.writer.withdraw).toHaveBeenCalledWith('w1', 'r1', {
                userId: 'u1',
                isWorkOwner: false,
            });
            const asCreator = build({ creator: true });
            await asCreator.controller.withdraw(human, 'w1', 'r1');
            expect(asCreator.writer.withdraw).toHaveBeenCalledWith('w1', 'r1', {
                userId: 'u1',
                isWorkOwner: true,
            });
        });

        it('turns a service refusal into its status and code', async () => {
            const { controller, writer } = build();
            writer.withdraw.mockResolvedValueOnce({
                status: 'refused',
                httpStatus: 409,
                code: 'notWithdrawable',
                message: 'open',
            } as never);
            const result = await statusOf(controller.withdraw(human, 'w1', 'r1'));
            expect(result).toMatchObject({ status: 409, body: { code: 'notWithdrawable' } });
        });

        it('refuses the acknowledgement from an API key before the service is called', async () => {
            const { controller, writer } = build();
            const result = await statusOf(controller.acknowledgeExtraFiles(apiKey, 'w1', 'r1'));
            expect(result.status).toBe(403);
            expect(writer.acknowledgeExtraFiles).not.toHaveBeenCalled();
            await controller.acknowledgeExtraFiles(human, 'w1', 'r1');
            expect(writer.acknowledgeExtraFiles).toHaveBeenCalledWith('w1', 'r1', 'u1');
        });
    });
});

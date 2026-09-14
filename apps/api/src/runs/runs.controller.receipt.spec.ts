// Run receipt (AW-09) — unit spec for `GET /api/runs/:runId/receipt`.
//
// Focus: the endpoint is not an existence oracle. A run that does not exist
// and a run that belongs to someone else produce the SAME 404 with the same
// body, and the lookup is always keyed on the authenticated user + scope.
jest.mock('@ever-works/agent/agents', () => ({
    RunLedgerService: class RunLedgerService {},
    RunReceiptService: class RunReceiptService {},
}));
jest.mock('../auth', () => ({
    AuthSessionGuard: class AuthSessionGuard {},
    CurrentUser: () => () => undefined,
}));
jest.mock('../scope', () => ({ ScopeContextService: class ScopeContextService {} }));

import { NotFoundException, ParseUUIDPipe } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import { RunsController } from './runs.controller';

const OWNER = { userId: 'user-1' } as AuthenticatedUser;
const STRANGER = { userId: 'user-2' } as AuthenticatedUser;
const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' };
const RUN_ID = '0b7e7c1e-6f6a-4c55-9a4c-1f2b3c4d5e6f';
const MISSING_ID = '9f9f9f9f-6f6a-4c55-9a4c-1f2b3c4d5e6f';

const RECEIPT = {
    row: { id: RUN_ID, missionId: null, missionTitle: null },
    cost: {
        settledCents: 31,
        meteredCents: 31,
        soFar: false,
        creditsDebited: 12,
        detailRetained: true,
        tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: 900 },
        lines: [],
    },
    counts: { messages: 3, toolCalls: 2, filesTouched: 1 },
    filesTouched: ['README.md'],
    captureTruncated: false,
    knowledge: [],
};

describe('RunsController — receipt', () => {
    let receipts: { getReceipt: jest.Mock };
    let controller: RunsController;

    beforeEach(() => {
        receipts = {
            // Only the owner resolves the run; everyone else — and every
            // unknown id — reads null from the scoped service.
            getReceipt: jest.fn(async (userId: string, runId: string) =>
                userId === OWNER.userId && runId === RUN_ID ? RECEIPT : null,
            ),
        };
        controller = new RunsController(
            {} as never,
            receipts as never,
            {
                getScope: () => SCOPE,
            } as never,
        );
    });

    it('returns the receipt, with its P1 cost block shape, to the owner', async () => {
        await expect(controller.receipt(OWNER, RUN_ID)).resolves.toBe(RECEIPT);
        expect(receipts.getReceipt).toHaveBeenCalledWith('user-1', RUN_ID, SCOPE);
        expect(Object.keys(RECEIPT.cost).sort()).toEqual([
            'creditsDebited',
            'detailRetained',
            'lines',
            'meteredCents',
            'settledCents',
            'soFar',
            'tokens',
        ]);
    });

    it('answers a foreign run and a missing run with byte-identical 404s', async () => {
        const capture = async (auth: AuthenticatedUser, runId: string) => {
            try {
                await controller.receipt(auth, runId);
            } catch (error) {
                return error;
            }
            throw new Error('expected a 404');
        };

        const foreign = (await capture(STRANGER, RUN_ID)) as NotFoundException;
        const missing = (await capture(OWNER, MISSING_ID)) as NotFoundException;

        expect(foreign).toBeInstanceOf(NotFoundException);
        expect(missing).toBeInstanceOf(NotFoundException);
        expect(JSON.stringify(foreign.getResponse())).toBe(JSON.stringify(missing.getResponse()));
        expect(foreign.getStatus()).toBe(404);
        // The stranger's lookup was still keyed on the stranger, never on the owner.
        expect(receipts.getReceipt).toHaveBeenCalledWith('user-2', RUN_ID, SCOPE);
    });

    it('guards the id with ParseUUIDPipe so a literal segment can never be read as a run id', () => {
        const params = Reflect.getMetadata(
            '__routeArguments__',
            RunsController,
            'receipt',
        ) as Record<string, { pipes?: unknown[] }>;
        const pipes = Object.values(params).flatMap((param) => param.pipes ?? []);
        expect(pipes).toContain(ParseUUIDPipe);
    });

    it('reads without a scope when no scope context is bound', async () => {
        const unscoped = new RunsController({} as never, receipts as never);

        await unscoped.receipt(OWNER, RUN_ID);

        expect(receipts.getReceipt).toHaveBeenCalledWith('user-1', RUN_ID, undefined);
    });
});

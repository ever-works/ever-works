import { FleetSessionActionService } from '../fleet-session-action.service';
import { fleetSessionError, readFleetSessionError } from '../../sessions/fleet-session.errors';

async function refusal(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        return readFleetSessionError(error);
    }
    throw new Error('expected a refusal');
}

/**
 * FL-06 P2 — the send path's refusals and its ledger (spec FR-15, FR-21,
 * FR-23, FR-24). Fakes stand in for the session service, the repositories and
 * the audit; the relevance table itself is pinned in the contracts spec.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const CHECKOUT_ID = '33333333-3333-4333-8333-333333333333';

function session(overrides: Record<string, unknown> = {}) {
    return {
        id: SESSION_ID,
        nodeId: 'node-1',
        userId: 'user-1',
        organizationId: null,
        kind: 'agent',
        provider: 'claude-code',
        agentId: null,
        agentRunId: RUN_ID,
        checkoutId: CHECKOUT_ID,
        state: 'working',
        daemonSessionId: 'd-1',
        ...overrides,
    };
}

function checkout() {
    return {
        id: CHECKOUT_ID,
        nodeId: 'node-1',
        state: 'ready',
        branch: 'nina/fix-login',
        baseRef: 'main',
        workId: null,
        gitLine: {
            branch: 'nina/fix-login',
            isWorktree: true,
            baseRef: 'main',
            ahead: 1,
            behind: 0,
            added: 1,
            removed: 0,
            filesChanged: 1,
            uncommitted: 1,
            pr: null,
            at: '2026-10-21T10:00:00.000Z',
        },
    };
}

function build(options: { typeAction?: jest.Mock; row?: Record<string, unknown> } = {}) {
    const row = options.row ?? session();
    const typeAction = options.typeAction ?? jest.fn().mockResolvedValue(undefined);
    const saved: Record<string, unknown>[] = [];
    const logs = {
        create: jest.fn((value: Record<string, unknown>) => value),
        save: jest.fn(async (value: Record<string, unknown>) => {
            const stored = { ...value, id: '44444444-4444-4444-8444-44444444444' + saved.length };
            saved.push(stored);
            return stored;
        }),
        update: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
    };
    const audit = { record: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    const service = new FleetSessionActionService(
        {
            resolve: jest.fn().mockResolvedValue({
                session: row,
                node: { id: 'node-1', userId: 'user-1', name: 'build-01' },
            }),
            typeAction,
            isReachable: jest.fn().mockReturnValue(true),
        } as never,
        { findById: jest.fn().mockResolvedValue(checkout()) } as never,
        { isStopped: jest.fn().mockResolvedValue(false) } as never,
        logs as never,
        {} as never,
        audit as never,
    );
    return { service, typeAction, logs, audit, saved };
}

describe('FleetSessionActionService.send (FL-06)', () => {
    it('types the prompt as one line + Enter and writes a delivered ledger row and one audit row', async () => {
        const { service, typeAction, logs, audit } = build();
        const result = await service.send(
            SESSION_ID,
            { userId: 'user-1' },
            { actionId: 'commit', prompt: 'Commit\nnow' },
        );
        expect(result.delivery).toBe('delivered');
        expect(typeAction).toHaveBeenCalledWith(
            expect.anything(),
            { userId: 'user-1' },
            'Commit now\r',
            expect.objectContaining({ actionId: 'commit' }),
        );
        const meta = logs.update.mock.calls[0][1].metadata as Record<string, unknown>;
        expect(meta.deliveredAt).toEqual(expect.any(String));
        expect(JSON.stringify(logs.save.mock.calls[0][0])).not.toContain('Commit now');
        expect(audit.record).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'node.session.action',
                details: expect.objectContaining({ action: 'commit', delivery: 'delivered' }),
            }),
        );
    });

    it('refuses a hidden action with invalid naming the rule (U5)', async () => {
        const { service } = build();
        expect(
            (
                await refusal(
                    service.send(
                        SESSION_ID,
                        { userId: 'user-1' },
                        { actionId: 'fixComments', prompt: 'x' },
                    ),
                )
            )?.details?.rule,
        ).toBe('no-open-pull-request');
    });

    it('refuses a second send within 2 s with busy naming who sent the first (U14)', async () => {
        const { service } = build();
        await service.send(SESSION_ID, { userId: 'user-1' }, { actionId: 'commit', prompt: 'one' });
        expect(
            (
                await refusal(
                    service.send(
                        SESSION_ID,
                        { userId: 'user-2' },
                        { actionId: 'recap', prompt: 'two' },
                    ),
                )
            )?.code,
        ).toBe('busy');
    });

    it('marks a send the computer could not confirm as not delivered, never retried (U13)', async () => {
        const unreachable = fleetSessionError('unreachable', 'the computer is not connected');
        const { service, logs } = build({ typeAction: jest.fn().mockRejectedValue(unreachable) });
        const result = await service.send(
            SESSION_ID,
            { userId: 'user-1' },
            { actionId: 'recap', prompt: 'Recap' },
        );
        expect(result.delivery).toBe('undelivered');
        expect((logs.update.mock.calls[0][1].metadata as Record<string, unknown>).undelivered).toBe(
            true,
        );
    });

    it('opens the pull request of an owner session from the dialog, never from a prompt (FR-18)', async () => {
        const { service } = build({ row: session({ kind: 'owner', agentRunId: null }) });
        expect(
            (
                await refusal(
                    service.send(
                        SESSION_ID,
                        { userId: 'user-1' },
                        { actionId: 'pullRequest', prompt: 'x' },
                    ),
                )
            )?.details?.rule,
        ).toBe('owner-dialog');
    });
});

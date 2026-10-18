import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { FleetRunOrgPinGuard, workIdOfPath } from './fleet-run-org-pin.guard';
import {
    fleetRunOrganizationPin,
    isFleetRunOrgPinEnforced,
    isInsideOrganizationPin,
} from '../fleet-run-scope';

/**
 * Works-security (run-token scope) — a fleet-run token reaches a Work (and the
 * Knowledge Base nested under it) only inside the Organization it was minted
 * for. Before this guard `WorkOwnershipService` answered "creator or member"
 * and nothing more, so a prompt-injected run in Organization A read every Work
 * of the owner's other Organizations.
 */
const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const WORK_PERSONAL = '33333333-3333-4333-8333-333333333333';

const WORKS: Record<string, { id: string; organizationId: string | null }> = {
    [WORK_A]: { id: WORK_A, organizationId: 'org-a' },
    [WORK_B]: { id: WORK_B, organizationId: 'org-b' },
    [WORK_PERSONAL]: { id: WORK_PERSONAL, organizationId: null },
};

function runBinding(organizationId: string | null) {
    return { jobId: 'job-1', nodeId: 'node-1', runId: 'run-1', organizationId, agentId: null };
}

function contextFor(request: Record<string, unknown>): ExecutionContext {
    return {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
}

describe('FleetRunOrgPinGuard', () => {
    const ORIGINAL = process.env.FLEET_RUN_TOKEN_ORG_PIN_ENFORCED;
    let works: { findByIdForAccess: jest.Mock };
    let guard: FleetRunOrgPinGuard;

    beforeEach(() => {
        delete process.env.FLEET_RUN_TOKEN_ORG_PIN_ENFORCED;
        works = {
            findByIdForAccess: jest.fn(async (id: string) => WORKS[id] ?? null),
        };
        guard = new FleetRunOrgPinGuard(works as never);
    });

    afterAll(() => {
        if (ORIGINAL === undefined) delete process.env.FLEET_RUN_TOKEN_ORG_PIN_ENFORCED;
        else process.env.FLEET_RUN_TOKEN_ORG_PIN_ENFORCED = ORIGINAL;
    });

    it('lets a run token reach a Work of its own Organization', async () => {
        await expect(
            guard.canActivate(
                contextFor({
                    path: `/api/works/${WORK_A}/kb/documents`,
                    fleetRunCredential: runBinding('org-a'),
                }),
            ),
        ).resolves.toBe(true);
        expect(works.findByIdForAccess).toHaveBeenCalledWith(WORK_A);
    });

    it("answers 404 for a Work of the owner's OTHER Organization (Work, KB, deploy routes)", async () => {
        for (const path of [
            `/api/works/${WORK_B}`,
            `/api/works/${WORK_B}/kb/documents`,
            `/api/works/${WORK_B}/kb/documents/notes.md`,
            `/api/deploy/works/${WORK_B}/domains`,
        ]) {
            await expect(
                guard.canActivate(contextFor({ path, fleetRunCredential: runBinding('org-a') })),
            ).rejects.toBeInstanceOf(NotFoundException);
        }
    });

    it('keeps an Organization run out of personal Works, and a personal run out of every Organization', async () => {
        await expect(
            guard.canActivate(
                contextFor({
                    path: `/api/works/${WORK_PERSONAL}`,
                    fleetRunCredential: runBinding('org-a'),
                }),
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            guard.canActivate(
                contextFor({
                    path: `/api/works/${WORK_A}`,
                    fleetRunCredential: runBinding(null),
                }),
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            guard.canActivate(
                contextFor({
                    path: `/api/works/${WORK_PERSONAL}/config`,
                    fleetRunCredential: runBinding(null),
                }),
            ),
        ).resolves.toBe(true);
    });

    it('answers 404 for a missing Work and for a non-id segment (the cross-Organization /api/works/stats)', async () => {
        await expect(
            guard.canActivate(
                contextFor({
                    path: '/api/works/44444444-4444-4444-8444-444444444444',
                    fleetRunCredential: runBinding('org-a'),
                }),
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
            guard.canActivate(
                contextFor({ path: '/api/works/stats', fleetRunCredential: runBinding('org-a') }),
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
        // The non-id segment never reaches the database (a uuid column would 500 on it).
        expect(works.findByIdForAccess).toHaveBeenCalledTimes(1);
    });

    it('reads the path from `url` (query stripped) when `path` is absent', async () => {
        await expect(
            guard.canActivate(
                contextFor({
                    url: `/api/works/${WORK_B}/items?limit=5`,
                    fleetRunCredential: runBinding('org-a'),
                }),
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fails closed for a run token when no Work repository is bound', async () => {
        const unbound = new FleetRunOrgPinGuard(undefined);
        await expect(
            unbound.canActivate(
                contextFor({ path: `/api/works/${WORK_A}`, fleetRunCredential: runBinding('org-a') }),
            ),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('leaves sessions, personal keys and paths that address no Work untouched', async () => {
        await expect(
            guard.canActivate(contextFor({ path: `/api/works/${WORK_B}`, user: { userId: 'u1' } })),
        ).resolves.toBe(true);
        await expect(
            guard.canActivate(
                contextFor({ path: '/api/tasks/abc', fleetRunCredential: runBinding('org-a') }),
            ),
        ).resolves.toBe(true);
        await expect(
            guard.canActivate(contextFor({ path: '/api/works', fleetRunCredential: runBinding('org-a') })),
        ).resolves.toBe(true);
        expect(works.findByIdForAccess).not.toHaveBeenCalled();
    });

    it('is off when FLEET_RUN_TOKEN_ORG_PIN_ENFORCED=false (the pre-2026-10-18 owner-wide reach)', async () => {
        process.env.FLEET_RUN_TOKEN_ORG_PIN_ENFORCED = 'false';
        await expect(
            guard.canActivate(
                contextFor({ path: `/api/works/${WORK_B}`, fleetRunCredential: runBinding('org-a') }),
            ),
        ).resolves.toBe(true);
        expect(works.findByIdForAccess).not.toHaveBeenCalled();
    });

    it('skips non-HTTP contexts', async () => {
        const rpc = { getType: () => 'rpc' } as unknown as ExecutionContext;
        await expect(guard.canActivate(rpc)).resolves.toBe(true);
    });
});

describe('workIdOfPath', () => {
    it('finds the Work id of both route families, case-insensitively, decoded', () => {
        expect(workIdOfPath(`/api/works/${WORK_A}`)).toBe(WORK_A);
        expect(workIdOfPath(`/API/Works/${WORK_A}/kb/documents?q=x`)).toBe(WORK_A);
        expect(workIdOfPath(`/api/deploy/works/${WORK_A}/check`)).toBe(WORK_A);
        expect(workIdOfPath('/api/works/a%20b')).toBe('a b');
    });

    it('answers undefined for paths that address no Work', () => {
        expect(workIdOfPath('/api/works')).toBeUndefined();
        expect(workIdOfPath('/api/deploy/providers')).toBeUndefined();
        expect(workIdOfPath('/api/me/missions/x/works')).toBeUndefined();
        expect(workIdOfPath(undefined)).toBeUndefined();
    });
});

describe('fleet-run-scope helpers', () => {
    it('defaults the pin ON; only the literal false / 0 turns it off', () => {
        expect(isFleetRunOrgPinEnforced({})).toBe(true);
        expect(isFleetRunOrgPinEnforced({ FLEET_RUN_TOKEN_ORG_PIN_ENFORCED: 'true' })).toBe(true);
        expect(isFleetRunOrgPinEnforced({ FLEET_RUN_TOKEN_ORG_PIN_ENFORCED: 'nope' })).toBe(true);
        expect(isFleetRunOrgPinEnforced({ FLEET_RUN_TOKEN_ORG_PIN_ENFORCED: ' FALSE ' })).toBe(false);
        expect(isFleetRunOrgPinEnforced({ FLEET_RUN_TOKEN_ORG_PIN_ENFORCED: '0' })).toBe(false);
    });

    it('pins only a fleet-run request, to its binding (empty = personal scope)', () => {
        expect(fleetRunOrganizationPin({}, {})).toBeNull();
        expect(fleetRunOrganizationPin({ fleetRunCredential: runBinding('org-a') }, {})).toEqual({
            organizationId: 'org-a',
        });
        expect(
            fleetRunOrganizationPin({ fleetRunCredential: { ...runBinding(null), organizationId: '' } }, {}),
        ).toEqual({ organizationId: null });
        expect(
            fleetRunOrganizationPin(
                { fleetRunCredential: runBinding('org-a') },
                { FLEET_RUN_TOKEN_ORG_PIN_ENFORCED: 'false' },
            ),
        ).toBeNull();
    });

    it('matches a record only inside the pin (null matches null only)', () => {
        expect(isInsideOrganizationPin({ organizationId: 'org-a' }, { organizationId: 'org-a' })).toBe(true);
        expect(isInsideOrganizationPin({ organizationId: 'org-b' }, { organizationId: 'org-a' })).toBe(false);
        expect(isInsideOrganizationPin({ organizationId: null }, { organizationId: null })).toBe(true);
        expect(isInsideOrganizationPin({}, { organizationId: null })).toBe(true);
        expect(isInsideOrganizationPin({ organizationId: 'org-a' }, { organizationId: null })).toBe(false);
        expect(isInsideOrganizationPin(null, { organizationId: null })).toBe(false);
    });
});

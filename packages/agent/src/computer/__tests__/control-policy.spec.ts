import {
    COMPUTER_CONTROL_POLICIES,
    COMPUTER_VIEWER_ROLES,
    type ComputerControlPolicy,
    type ComputerViewerRole,
} from '@ever-works/contracts';
import {
    COMPUTER_CONTROL_ACK_FLOOR_MS,
    canControl,
    controlGrantDeadlines,
    controlIdleDeadline,
    controlRequestExpiresAt,
    extendedControlExpiry,
    isControlRequestPending,
    resolveComputerControlLimits,
    resolveControlLockExpiry,
    viewerRoleForNode,
} from '../control-policy';

/**
 * The control rules as pure functions: who may take control under each
 * policy, the operator clamps, and the exact instants a hold and a request
 * stop being in force (at the boundary and one millisecond either side).
 */

const T0 = new Date('2026-09-14T09:00:00.000Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const LIMITS = resolveComputerControlLimits({});

describe('canControl — policy × role', () => {
    const table: Record<ComputerControlPolicy, Record<ComputerViewerRole, boolean>> = {
        owner: { owner: true, 'org-admin': false, 'org-member': false, stranger: false },
        'org-admins': { owner: true, 'org-admin': true, 'org-member': false, stranger: false },
        'org-members': { owner: true, 'org-admin': true, 'org-member': true, stranger: false },
    };

    it('covers every policy and every role', () => {
        expect(Object.keys(table).sort()).toEqual([...COMPUTER_CONTROL_POLICIES].sort());
        for (const policy of COMPUTER_CONTROL_POLICIES) {
            expect(Object.keys(table[policy]).sort()).toEqual([...COMPUTER_VIEWER_ROLES].sort());
        }
    });

    it.each(
        COMPUTER_CONTROL_POLICIES.flatMap((policy) =>
            COMPUTER_VIEWER_ROLES.map((role) => [policy, role, table[policy][role]] as const),
        ),
    )('%s × %s → %s', (policy, role, expected) => {
        expect(canControl(policy, role)).toBe(expected);
    });

    it('resolves the owner of a machine as its owner, and anyone else as a stranger', () => {
        expect(viewerRoleForNode({ userId: 'u1' }, { userId: 'u1' })).toBe('owner');
        expect(viewerRoleForNode({ userId: 'u1' }, { userId: 'u2' })).toBe('stranger');
    });
});

describe('resolveComputerControlLimits', () => {
    it('defaults to 10 minutes idle, 60 minutes per stretch, 30 s disconnect and 60 s requests', () => {
        expect(LIMITS).toEqual({
            idleMs: 10 * 60_000,
            ceilingMs: 60 * 60_000,
            disconnectMs: 30_000,
            requestTimeoutMs: 60_000,
            ackFloorMs: COMPUTER_CONTROL_ACK_FLOOR_MS,
        });
    });

    it('clamps operator values and ignores nonsense rather than turning a limit off', () => {
        expect(resolveComputerControlLimits({ COMPUTER_CONTROL_IDLE_MINUTES: '0' }).idleMs).toBe(
            60_000,
        );
        expect(resolveComputerControlLimits({ COMPUTER_CONTROL_IDLE_MINUTES: '999' }).idleMs).toBe(
            60 * 60_000,
        );
        expect(resolveComputerControlLimits({ COMPUTER_CONTROL_MAX_MINUTES: '1' }).ceilingMs).toBe(
            5 * 60_000,
        );
        expect(
            resolveComputerControlLimits({ COMPUTER_CONTROL_MAX_MINUTES: '100000' }).ceilingMs,
        ).toBe(240 * 60_000);
        expect(
            resolveComputerControlLimits({ COMPUTER_CONTROL_MAX_MINUTES: 'forever' }).ceilingMs,
        ).toBe(60 * 60_000);
    });

    it('keeps the acknowledgement floor above two socket heartbeats', () => {
        expect(COMPUTER_CONTROL_ACK_FLOOR_MS).toBeGreaterThanOrEqual(60_000);
    });
});

describe('resolveControlLockExpiry', () => {
    const held = {
        controlHolderSessionId: 's1',
        controlHeldSince: T0,
        ...controlGrantDeadlines(T0, LIMITS),
        controlAckAt: T0,
    };
    const lock = { ...held, controlExpiresAt: held.expiresAt, controlIdleAt: held.idleAt };

    it('is null when nobody holds the lock', () => {
        expect(resolveControlLockExpiry({}, at(10 ** 9), LIMITS)).toBeNull();
    });

    it('releases for inactivity at the idle deadline, not a millisecond before', () => {
        const fresh = { ...lock, controlAckAt: at(10 * 60_000 - 1) };
        expect(resolveControlLockExpiry(fresh, at(10 * 60_000 - 1), LIMITS)).toBeNull();
        expect(resolveControlLockExpiry(fresh, at(10 * 60_000), LIMITS)).toBe('idle');
        expect(resolveControlLockExpiry(fresh, at(10 * 60_000 + 1), LIMITS)).toBe('idle');
    });

    it('names the ceiling first when both the ceiling and inactivity have passed', () => {
        expect(resolveControlLockExpiry(lock, at(60 * 60_000 - 1), LIMITS)).toBe('idle');
        expect(resolveControlLockExpiry(lock, at(60 * 60_000), LIMITS)).toBe('ceiling');
    });

    it('releases an unacknowledged hold at the floor', () => {
        const idleFar = { ...lock, controlIdleAt: at(60 * 60_000 - 1) };
        expect(resolveControlLockExpiry(idleFar, at(LIMITS.ackFloorMs - 1), LIMITS)).toBeNull();
        expect(resolveControlLockExpiry(idleFar, at(LIMITS.ackFloorMs), LIMITS)).toBe(
            'disconnected',
        );
    });
});

describe('requests, idle and extension', () => {
    it('keeps a request pending for 60 seconds exactly', () => {
        const lock = { controlRequestSessionId: 's2', controlRequestedAt: T0 };
        expect(isControlRequestPending(lock, at(59_999), LIMITS)).toBe(true);
        expect(isControlRequestPending(lock, at(60_000), LIMITS)).toBe(false);
        expect(isControlRequestPending({}, T0, LIMITS)).toBe(false);
        expect(controlRequestExpiresAt(lock, LIMITS)?.toISOString()).toBe(at(60_000).toISOString());
    });

    it('never lets input push the idle deadline past the end of the stretch', () => {
        const lock = { controlExpiresAt: at(15 * 60_000) };
        expect(controlIdleDeadline(lock, at(1000), LIMITS).toISOString()).toBe(
            at(10 * 60_000 + 1000).toISOString(),
        );
        expect(controlIdleDeadline(lock, at(12 * 60_000), LIMITS).toISOString()).toBe(
            at(15 * 60_000).toISOString(),
        );
    });

    it('extends by one full stretch on top of the current one', () => {
        const lock = { controlExpiresAt: at(60 * 60_000) };
        expect(extendedControlExpiry(lock, at(59 * 60_000), LIMITS).toISOString()).toBe(
            at(120 * 60_000).toISOString(),
        );
    });
});

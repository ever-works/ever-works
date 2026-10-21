import type { FleetNodeCheckoutRecord } from '@ever-works/contracts';
import {
    checkoutPatchFromRecord,
    checkoutSizeBytes,
    createdByFromOrigin,
    isCheckoutFolderRemoved,
    isCreatingStale,
    isOmittedRowMissing,
    nextCheckoutState,
    refreshAllowedAt,
} from '../fleet-checkout.policy';

const NOW = new Date('2026-10-21T12:00:00.000Z');

function record(overrides: Partial<FleetNodeCheckoutRecord> = {}): FleetNodeCheckoutRecord {
    return {
        path: '/home/nina/code/api',
        checkoutId: null,
        kind: 'discovered',
        origin: 'discovery',
        parentPath: null,
        remoteUrl: 'https://github.com/acme/api',
        remoteHadCredential: false,
        branch: 'main',
        baseRef: null,
        headSha: null,
        isolation: 'host',
        present: true,
        gitLine: null,
        sizeBytes: 2048,
        busy: null,
        reaperNote: null,
        lastUsedAt: null,
        ...overrides,
    };
}

describe('checkout state machine (FL-14 spec §1, FR-11, FR-13, U14)', () => {
    it.each([
        [null, true, 'ready'],
        [null, false, 'missing'],
        ['ready', true, 'ready'],
        ['ready', false, 'missing'],
        ['missing', true, 'ready'],
        ['missing', false, 'missing'],
        ['creating', true, 'ready'],
        ['creating', false, 'creating'],
        ['archived', true, 'archived'],
        ['archived', false, 'archived'],
    ] as const)('%s + present=%s → %s', (current, present, expected) => {
        expect(nextCheckoutState(current, present)).toBe(expected);
    });

    it('keeps last-known facts when the folder is gone (FR-15: dimmed, never blank)', () => {
        const row = {
            state: 'ready' as const,
            gitLine: null,
            sizeBytes: 100,
            lastSeenAt: new Date('2026-10-20T00:00:00.000Z'),
            branch: 'main',
            baseRef: null,
            remoteUrl: 'https://github.com/acme/api',
        };
        const patch = checkoutPatchFromRecord(
            row,
            record({ present: false, branch: null, sizeBytes: null }),
            NOW,
        );
        expect(patch.state).toBe('missing');
        expect(patch).not.toHaveProperty('branch');
        expect(patch).not.toHaveProperty('lastSeenAt');
        expect(patch).not.toHaveProperty('sizeBytes');
    });

    it('stamps lastSeenAt when the folder is there', () => {
        expect(checkoutPatchFromRecord(null, record(), NOW).lastSeenAt).toEqual(NOW);
    });

    it('marks omitted rows missing, but never the bin or a young creating row', () => {
        const now = NOW.getTime();
        expect(isOmittedRowMissing({ state: 'ready', createdAt: NOW }, now)).toBe(true);
        expect(isOmittedRowMissing({ state: 'archived', createdAt: NOW }, now)).toBe(false);
        expect(isOmittedRowMissing({ state: 'creating', createdAt: NOW }, now)).toBe(false);
        expect(
            isOmittedRowMissing({ state: 'creating', createdAt: new Date(now - 11 * 60_000) }, now),
        ).toBe(true);
    });

    it('sweeps creating rows after ten minutes only', () => {
        const now = NOW.getTime();
        const young = { state: 'creating' as const, createdAt: new Date(now - 9 * 60_000) };
        const old = { state: 'creating' as const, createdAt: new Date(now - 10 * 60_000) };
        expect(isCreatingStale(young, now)).toBe(false);
        expect(isCreatingStale(old, now)).toBe(true);
        expect(isCreatingStale({ state: 'ready', createdAt: new Date(0) }, now)).toBe(false);
    });

    it('offers no Restore once a delete removed the folder (FR-26)', () => {
        const deleted = { command: 'delete', exitCode: 0, at: NOW.toISOString() };
        expect(isCheckoutFolderRemoved({ state: 'archived', lastCommand: deleted })).toBe(true);
        expect(isCheckoutFolderRemoved({ state: 'archived', lastCommand: null })).toBe(false);
        expect(isCheckoutFolderRemoved({ state: 'ready', lastCommand: deleted })).toBe(false);
    });

    it('throttles a manual refresh to once per window (FR-9)', () => {
        expect(refreshAllowedAt(undefined, 1000, 10_000)).toBeNull();
        expect(refreshAllowedAt(1000, 5000, 10_000)).toBe(11_000);
        expect(refreshAllowedAt(1000, 11_000, 10_000)).toBeNull();
    });

    it('maps node origins to creators and reads bigint sizes', () => {
        expect(createdByFromOrigin('task')).toBe('task');
        expect(createdByFromOrigin('discovery')).toBe('discovery');
        expect(createdByFromOrigin('platform')).toBe('user');
        expect(checkoutSizeBytes('4096')).toBe(4096);
        expect(checkoutSizeBytes(null)).toBeNull();
        expect(checkoutSizeBytes('nope')).toBeNull();
    });
});

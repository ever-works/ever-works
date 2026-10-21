import { describe, expect, it } from 'vitest';
import type { FleetCheckoutView } from '@ever-works/contracts';
import {
    checkoutActionState,
    checkoutsPollMs,
    formatCheckoutSize,
    groupCheckoutsByRepository,
    homeRelativePath,
    totalCheckoutBytes,
} from './checkouts.shared';

function row(overrides: Partial<FleetCheckoutView> = {}): FleetCheckoutView {
    return {
        id: 'c1',
        nodeId: 'n1',
        userId: 'u1',
        path: '/home/nina/code/api',
        kind: 'discovered',
        parentCheckoutId: null,
        remoteUrl: 'https://github.com/acme/api',
        remoteHadCredential: false,
        repository: 'acme/api',
        repositoryHost: 'github.com',
        workId: null,
        workName: null,
        branch: 'main',
        baseRef: null,
        isolation: 'host',
        state: 'ready',
        createdBy: 'discovery',
        gitLine: null,
        lastCommand: null,
        sizeBytes: 1024,
        lastSeenAt: null,
        archivedAt: null,
        folderRemoved: false,
        reaperNote: null,
        busy: null,
        createdAt: '2026-10-21T00:00:00.000Z',
        updatedAt: '2026-10-21T00:00:00.000Z',
        ...overrides,
    };
}

const ONLINE_OWNER = {
    status: 'online' as const,
    consents: { work: true, attend: false, manage: true, usageScan: false },
    viewerRole: 'owner' as const,
};

describe('groupCheckoutsByRepository (FL-14 spec §5.1, S2)', () => {
    it('puts one repository on two computers under one heading, the Work name when linked', () => {
        const groups = groupCheckoutsByRepository([
            row({ id: 'a', nodeId: 'n1', workId: 'w1', workName: 'API' }),
            row({ id: 'b', nodeId: 'n2', workId: 'w1', workName: 'API', path: '/home/nina/x' }),
            row({ id: 'c', repository: 'acme/web', path: '/home/nina/web' }),
            row({ id: 'd', repository: null, remoteUrl: null, path: '/home/nina/scratch' }),
        ]);
        expect(groups.map((group) => [group.kind, group.label, group.rows.length, group.computers])).toEqual([
            ['work', 'API', 2, 2],
            ['repository', 'acme/web', 1, 1],
            ['unlinked', null, 1, 1],
        ]);
    });

    it('never merges a same-named repository on another host', () => {
        const groups = groupCheckoutsByRepository([
            row({ id: 'a' }),
            row({ id: 'b', repositoryHost: 'git.example.com' }),
        ]);
        expect(groups).toHaveLength(2);
    });
});

describe('checkoutActionState (spec U1–U4, U9, FR-13, FR-26)', () => {
    it('allows fetch, refresh and archive on a ready row for the owner of an online computer', () => {
        for (const action of ['fetch', 'refresh', 'archive'] as const) {
            expect(checkoutActionState(action, row(), { node: ONLINE_OWNER })).toEqual({ enabled: true });
        }
    });

    it.each([
        ['fetch', row(), { node: { ...ONLINE_OWNER, status: 'offline' as const } }, 'offline'],
        ['fetch', row(), { node: { ...ONLINE_OWNER, viewerRole: 'org-member' as const } }, 'notAllowed'],
        ['fetch', row(), { node: ONLINE_OWNER, stopped: true }, 'killSwitch'],
        ['fetch', row({ state: 'missing' }), { node: ONLINE_OWNER }, 'missing'],
        ['fetch', row({ createdBy: 'task', kind: 'worktree' }), { node: ONLINE_OWNER }, 'taskWorktree'],
        [
            'fetch',
            row(),
            { node: { ...ONLINE_OWNER, consents: { ...ONLINE_OWNER.consents, manage: false } } },
            'consentMissing',
        ],
        ['archive', row({ busy: 'session' }), { node: ONLINE_OWNER }, 'busy'],
        ['restore', row({ state: 'archived', folderRemoved: true }), { node: ONLINE_OWNER }, 'folderRemoved'],
        ['restore', row(), { node: ONLINE_OWNER }, 'archived'],
    ] as const)('%s is off: %s', (action, subject, context, reason) => {
        expect(checkoutActionState(action, subject, context)).toEqual({ enabled: false, reason });
    });

    it('archives an offline computer’s row (the bin is the platform’s), but restores only online', () => {
        const offline = { node: { ...ONLINE_OWNER, status: 'offline' as const } };
        expect(checkoutActionState('archive', row(), offline)).toEqual({ enabled: true });
        expect(checkoutActionState('restore', row({ state: 'archived' }), offline)).toEqual({
            enabled: false,
            reason: 'offline',
        });
    });
});

describe('formatters', () => {
    it('formats sizes and totals without the bin (spec FR-14)', () => {
        expect(formatCheckoutSize(420 * 1024 * 1024)).toBe('420 MB');
        expect(formatCheckoutSize(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
        expect(formatCheckoutSize(null)).toBeNull();
        expect(
            totalCheckoutBytes([
                { state: 'ready', sizeBytes: 10 },
                { state: 'archived', sizeBytes: 100 },
                { state: 'missing', sizeBytes: null },
            ]),
        ).toBe(10);
    });

    it('shows home-relative paths on every OS', () => {
        expect(homeRelativePath('/home/nina/code/api')).toBe('~/code/api');
        expect(homeRelativePath('/Users/nina/Developer/web')).toBe('~/Developer/web');
        expect(homeRelativePath('C:\\Users\\nina\\code\\api')).toBe('~\\code\\api');
        expect(homeRelativePath('/srv/checkouts/api')).toBe('/srv/checkouts/api');
    });

    it('polls fast only while something runs on a machine', () => {
        expect(checkoutsPollMs([{ state: 'ready', lastCommand: null }])).toBe(60_000);
        expect(checkoutsPollMs([{ state: 'creating', lastCommand: null }])).toBe(10_000);
        expect(
            checkoutsPollMs([
                { state: 'ready', lastCommand: { command: 'fetch', exitCode: null, at: '2026-10-21T00:00:00.000Z' } },
            ]),
        ).toBe(10_000);
    });
});

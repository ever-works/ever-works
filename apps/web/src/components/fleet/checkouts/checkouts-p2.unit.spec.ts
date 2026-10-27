import { describe, expect, it } from 'vitest';
import { readDeletePreview } from './DeleteCheckoutDialog';
import { checkoutActionState, checkoutRowActions } from './checkouts.shared';

const ONLINE_OWNER = {
    status: 'online' as const,
    consents: { work: true, attend: false, manage: true, usageScan: false },
    viewerRole: 'owner' as const,
};

describe('checkout row actions (FL-14 P2, spec FR-21 … FR-26)', () => {
    it('offers delete for a checkout Ever Works made, forget for one found or a Task worktree', () => {
        expect(checkoutRowActions({ state: 'ready', kind: 'worktree', createdBy: 'user' })).toEqual(
            ['fetch', 'pull', 'push', 'refresh', 'archive', 'delete'],
        );
        expect(
            checkoutRowActions({ state: 'ready', kind: 'discovered', createdBy: 'discovery' }),
        ).toContain('forget');
        expect(
            checkoutRowActions({ state: 'ready', kind: 'worktree', createdBy: 'task' }),
        ).toContain('forget');
        expect(checkoutRowActions({ state: 'archived', kind: 'clone', createdBy: 'user' })).toEqual(
            ['restore', 'delete'],
        );
    });

    it('lets fetch run beside a session but holds pull, push and delete (spec U9)', () => {
        const row = {
            state: 'ready' as const,
            busy: 'session' as const,
            folderRemoved: false,
            createdBy: 'user' as const,
            kind: 'worktree' as const,
        };
        expect(checkoutActionState('fetch', row, { node: ONLINE_OWNER })).toEqual({
            enabled: true,
        });
        expect(checkoutActionState('pull', row, { node: ONLINE_OWNER })).toEqual({
            enabled: false,
            reason: 'busy',
        });
        expect(checkoutActionState('push', row, { node: ONLINE_OWNER })).toEqual({
            enabled: false,
            reason: 'busy',
        });
        expect(checkoutActionState('delete', row, { node: ONLINE_OWNER })).toEqual({
            enabled: false,
            reason: 'busy',
        });
    });

    it('never deletes a discovered checkout', () => {
        expect(
            checkoutActionState(
                'delete',
                {
                    state: 'ready',
                    busy: null,
                    folderRemoved: false,
                    createdBy: 'discovery',
                    kind: 'discovered',
                },
                { node: ONLINE_OWNER },
            ),
        ).toEqual({ enabled: false, reason: 'discovered' });
    });
});

describe('readDeletePreview (CONTRACTS §2.2 confirmation_required details)', () => {
    it('reads the class, counts and name the API sent', () => {
        expect(
            readDeletePreview({
                class: 'confirm-destructive',
                uncommitted: 2,
                unpushedCommits: 1,
                name: 'fix-login',
                summary: '2 uncommitted files and 1 commit not on any remote would be lost.',
            }),
        ).toEqual({
            class: 'confirm-destructive',
            uncommitted: 2,
            unpushedCommits: 1,
            name: 'fix-login',
            summary: '2 uncommitted files and 1 commit not on any remote would be lost.',
        });
        expect(readDeletePreview({ class: 'blast-radius', name: 'x' })).toBeNull();
        expect(readDeletePreview(null)).toBeNull();
    });
});

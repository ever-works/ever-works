import { describe, expect, it } from 'vitest';
import type { FleetSessionAttention, FleetSessionView } from '@ever-works/contracts';
import {
    hookHealthLines,
    isSessionUnread,
    sessionCardBody,
    sessionElapsedSlot,
    sessionGlyph,
    sessionStateWords,
    sessionTint,
    statusSourceNote,
} from './sessions-status.shared';

/**
 * FL-05 card rules (spec FR-20 … FR-23, FR-53; ACC-FL05-11): the glyph
 * vocabulary, tint only where earned, the state always in words, the body,
 * the elapsed rule and the status-source note.
 */

const NOW = new Date('2026-10-21T12:00:00.000Z');

function session(overrides: Partial<FleetSessionView> = {}): FleetSessionView {
    return {
        id: 's1',
        nodeId: 'n1',
        userId: 'u1',
        organizationId: null,
        kind: 'owner',
        provider: 'claude-code',
        agentId: null,
        agentRunId: null,
        checkoutId: null,
        cwd: '/home/dana/code/api',
        title: 'api tests',
        state: 'working',
        outcome: null,
        endedReason: null,
        exitCode: null,
        recordingState: 'off',
        restartOfSessionId: null,
        firstMessage: null,
        startedBy: 'user:u1',
        lastActivityAt: '2026-10-21T11:56:00.000Z',
        startedAt: '2026-10-21T11:00:00.000Z',
        endedAt: null,
        createdAt: '2026-10-21T11:00:00.000Z',
        updatedAt: '2026-10-21T11:56:00.000Z',
        stateChangedAt: '2026-10-21T11:56:00.000Z',
        ...overrides,
    };
}

const permission: FleetSessionAttention = {
    key: 'fleet-session:s1:permission:1',
    reason: 'permission',
    prompt: 'Allow Bash(pnpm db:migrate)?',
    options: [
        { id: '1', label: 'Allow', primary: true },
        { id: '2', label: 'Deny', deny: true },
    ],
    raisedAt: '2026-10-21T11:57:00.000Z',
    acknowledgedAt: null,
};

describe('glyphs and tint', () => {
    it('follows the vocabulary', () => {
        expect(sessionGlyph(session())).toBe('spinner');
        expect(sessionGlyph(session({ state: 'needs_you', attention: permission }))).toBe(
            'question',
        );
        expect(
            sessionGlyph(
                session({ state: 'needs_you', attention: { ...permission, reason: 'blocked' } }),
            ),
        ).toBe('redDot');
        expect(sessionGlyph(session({ state: 'done', outcome: 'success' }))).toBe('check');
        expect(sessionGlyph(session({ state: 'done', outcome: 'interrupted' }))).toBe('mutedDot');
        expect(sessionGlyph(session({ state: 'ended', outcome: 'unconfirmed' }))).toBe(
            'dashedRing',
        );
        expect(sessionGlyph(session({ state: 'idle' }))).toBe('greyDot');
        expect(sessionGlyph(session({ provider: 'shell' }))).toBe('none');
    });

    it('tints only needs-you (warm) and a successful finish (green)', () => {
        expect(sessionTint(session({ state: 'needs_you' }))).toBe('warm');
        expect(sessionTint(session({ state: 'done', outcome: 'success' }))).toBe('green');
        expect(sessionTint(session({ state: 'done', outcome: 'failure' }))).toBe('neutral');
        expect(sessionTint(session())).toBe('neutral');
    });

    it('always names the state in words, with its reason or outcome', () => {
        expect(sessionStateWords(session({ state: 'needs_you', attention: permission }))).toEqual({
            key: 'needsYou',
            qualifier: 'reasonPermission',
        });
        expect(sessionStateWords(session({ state: 'done', outcome: 'success' }))).toEqual({
            key: 'done',
            qualifier: 'outcomeSuccess',
        });
        expect(sessionStateWords(session({ state: 'idle' })).qualifier).toBeNull();
    });
});

describe('the body', () => {
    it('shows the prompt while it needs you, else the last lines, else the ended line', () => {
        expect(sessionCardBody(session({ state: 'needs_you', attention: permission })).kind).toBe(
            'attention',
        );
        expect(
            sessionCardBody(session({ state: 'ended', outcome: 'failure', exitCode: 1 })),
        ).toEqual({
            kind: 'exited',
            code: 1,
        });
        expect(sessionCardBody(session({ state: 'ended', outcome: 'unconfirmed' }))).toEqual({
            kind: 'unconfirmed',
        });
        expect(
            sessionCardBody(
                session({
                    state: 'done',
                    outcome: 'success',
                    lastEvidence: {
                        source: 'hook',
                        at: '2026-10-21T11:56:00.000Z',
                        detail: {
                            event: 'stop',
                            seq: 9,
                            userLine: 'run the tests',
                            agentLine: 'All 42 tests pass.',
                        },
                    },
                }),
            ),
        ).toEqual({ kind: 'lines', userLine: 'run the tests', agentLine: 'All 42 tests pass.' });
    });
});

describe('elapsed, unread, status source', () => {
    it('measures from when the state moved', () => {
        expect(sessionElapsedSlot(session(), NOW)).toEqual({ key: 'workingFor', span: '4 min' });
        expect(
            sessionElapsedSlot(session({ state: 'needs_you', attention: permission }), NOW),
        ).toEqual({
            key: 'waiting',
            span: '3 min',
        });
        expect(sessionElapsedSlot(session({ state: 'done' }), NOW)?.key).toBe('doneAgo');
    });

    it('unread = raised and not acknowledged since', () => {
        expect(isSessionUnread(session({ attention: permission }))).toBe(true);
        expect(
            isSessionUnread(
                session({
                    attention: { ...permission, acknowledgedAt: '2026-10-21T11:58:00.000Z' },
                }),
            ),
        ).toBe(false);
        expect(isSessionUnread(session())).toBe(false);
    });

    it('names the status source when it is not the hooks', () => {
        const hooks = {
            provider: 'claude-code' as const,
            injected: true,
            events: ['UserPromptSubmit', 'PermissionRequest', 'Stop'],
        };
        expect(statusSourceNote(session({ hooks }))).toBeNull();
        expect(statusSourceNote(session({ hooks }), { detail: true })).toBe('hooks');
        expect(
            statusSourceNote(session({ hooks: { ...hooks, events: ['Stop'] } }), { detail: true }),
        ).toBe('partial');
        expect(statusSourceNote(session({ hooks: null }))).toBe('fromScreen');
        expect(statusSourceNote(session({ provider: 'shell' }), { detail: true })).toBe('shell');
        expect(statusSourceNote(session({ provider: 'shell' }))).toBeNull();
    });

    it('surfaces hook health from the daemon block', () => {
        expect(
            hookHealthLines({
                state: 'running',
                sessions: 1,
                hooks: { badTokenLastMinute: 23, spooled: 12 },
            }),
        ).toEqual([
            { key: 'badToken', count: 23 },
            { key: 'spooled', count: 12 },
        ]);
        expect(
            hookHealthLines({ state: 'running', sessions: 1, hooks: { badTokenLastMinute: 3 } }),
        ).toEqual([]);
        expect(hookHealthLines(null)).toEqual([]);
    });
});

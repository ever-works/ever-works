import { describe, expect, it } from 'vitest';
import type { FleetSessionView } from '@ever-works/contracts';
import {
    atOwnerLimit,
    canStartOwnerSession,
    defaultProvider,
    endedLine,
    errorField,
    groupSessions,
    heldLineCount,
    holdInput,
    providerInstalled,
    readSessionError,
    roleSentence,
    SESSION_HELD_INPUT_MAX_BYTES,
    sessionConsentCommand,
    sessionElapsed,
    sessionReconnectDelayMs,
    sessionsTabCard,
    sessionStateGlyph,
} from './sessions.shared';

function view(over: Partial<FleetSessionView> = {}): FleetSessionView {
    return {
        id: 's1',
        nodeId: 'n1',
        userId: 'u1',
        organizationId: null,
        kind: 'owner',
        provider: 'shell',
        agentId: null,
        agentRunId: null,
        checkoutId: null,
        cwd: '~/code/app',
        title: 'app',
        state: 'working',
        outcome: null,
        endedReason: null,
        exitCode: null,
        recordingState: 'off',
        restartOfSessionId: null,
        firstMessage: null,
        startedBy: 'user:u1',
        lastActivityAt: '2026-10-21T10:00:00.000Z',
        startedAt: '2026-10-21T09:00:00.000Z',
        endedAt: null,
        createdAt: '2026-10-21T09:00:00.000Z',
        updatedAt: '2026-10-21T10:00:00.000Z',
        ...over,
    };
}

const online = {
    status: 'online' as const,
    capabilities: ['sessions', 'claude-code'],
    workerState: null,
    lastHeartbeatAt: '2026-10-21T10:00:00.000Z',
    consents: { work: false, attend: false, manage: true, usageScan: false },
};

describe('sessions.shared (FL-04 P1b)', () => {
    it('names the consent and its command per kind', () => {
        expect(sessionConsentCommand('owner')).toBe('ever-works-node start --manage');
        expect(sessionConsentCommand('agent')).toBe('ever-works-node start --work');
    });

    it('leads the tab with offline, then a missing consent, then a down daemon', () => {
        expect(sessionsTabCard({ ...online, status: 'offline' }).kind).toBe('offline');
        expect(
            sessionsTabCard({ ...online, consents: { work: false, attend: false, manage: false, usageScan: false } }),
        ).toEqual({ kind: 'consent-missing', command: 'ever-works-node start --manage' });
        expect(
            sessionsTabCard({ ...online, sessionDaemon: { state: 'failed', reason: 'terminal support is missing', sessions: 0 } }),
        ).toEqual({ kind: 'daemon-down', reason: 'terminal support is missing' });
        expect(sessionsTabCard({ ...online, capabilities: ['claude-code'] }).kind).toBe('daemon-down');
        expect(sessionsTabCard(online).kind).toBe('none');
    });

    it('starts an owner session only with --manage and the sessions tag, online', () => {
        expect(canStartOwnerSession(online)).toBe(true);
        expect(canStartOwnerSession({ ...online, status: 'offline' })).toBe(false);
        expect(canStartOwnerSession({ ...online, capabilities: [] })).toBe(false);
    });

    it('greys a CLI the computer does not advertise; a shell needs nothing', () => {
        expect(providerInstalled(online, 'claude-code')).toBe(true);
        expect(providerInstalled(online, 'codex')).toBe(false);
        expect(providerInstalled({ capabilities: [] }, 'shell')).toBe(true);
        expect(defaultProvider(online)).toBe('claude-code');
        expect(defaultProvider({ capabilities: [] })).toBe('shell');
    });

    it('gives every state a word and a tone', () => {
        expect(sessionStateGlyph('needs_you')).toEqual({ key: 'needsYou', tone: 'warning' });
        expect(sessionStateGlyph('ended').key).toBe('ended');
    });

    it('says how long a session ran', () => {
        const now = new Date('2026-10-21T10:05:00.000Z');
        expect(sessionElapsed(view(), now)).toBe('1 h 05 min');
        expect(sessionElapsed(view({ startedAt: '2026-10-21T10:04:30.000Z' }), now)).toBe('30 s');
        expect(sessionElapsed(view({ endedAt: '2026-10-21T09:12:00.000Z' }), now)).toBe('12 min');
    });

    it('groups live before ended and counts the owner limit', () => {
        const sessions = [view({ id: 'a', state: 'ended', endedAt: '2026-10-21T08:00:00.000Z' }), view({ id: 'b' })];
        const grouped = groupSessions(sessions);
        expect(grouped.live.map((s) => s.id)).toEqual(['b']);
        expect(grouped.ended.map((s) => s.id)).toEqual(['a']);
        expect(atOwnerLimit(Array.from({ length: 8 }, (_, i) => view({ id: String(i) })))).toBe(true);
        expect(atOwnerLimit(Array.from({ length: 7 }, (_, i) => view({ id: String(i) })))).toBe(false);
    });

    it('words every ended reason', () => {
        expect(endedLine(view())).toBeNull();
        expect(endedLine(view({ state: 'ended', endedReason: 'exit', exitCode: 2 }))).toEqual({ key: 'endedExit', code: 2 });
        expect(endedLine(view({ state: 'ended', endedReason: 'exit', exitCode: null }))).toEqual({ key: 'endedLost' });
        for (const [reason, key] of [
            ['user', 'endedUser'],
            ['agent', 'endedAgent'],
            ['node-restart', 'endedNodeRestart'],
            ['drain', 'endedDrain'],
            ['kill-switch', 'endedKillSwitch'],
            ['timeout', 'endedTimeout'],
        ] as const) {
            expect(endedLine(view({ state: 'ended', endedReason: reason }))?.key).toBe(key);
        }
    });

    it('says who drives', () => {
        const presence = {
            attached: [
                { userId: 'u2', role: 'driver' as const, since: '' },
                { userId: 'u1', role: 'viewer' as const, since: '' },
            ],
            drivers: 1,
            watchers: 1,
        };
        expect(roleSentence(presence, { userId: 'u1', role: 'driver' })).toEqual({ key: 'driving' });
        expect(roleSentence(presence, { userId: 'u1', role: 'viewer' })).toEqual({ key: 'watchingDriven', others: 1 });
        expect(roleSentence(undefined, { userId: 'u1', role: 'viewer' })).toEqual({ key: 'nobodyDriving' });
    });

    it('holds typed input up to its cap and counts its lines', () => {
        expect(heldLineCount('')).toBe(0);
        expect(heldLineCount('ls')).toBe(1);
        expect(heldLineCount('ls\rpwd\r')).toBe(2);
        expect(heldLineCount('a\nb\nc')).toBe(3);
        const big = holdInput('', 'x'.repeat(SESSION_HELD_INPUT_MAX_BYTES + 10));
        expect(big.length).toBe(SESSION_HELD_INPUT_MAX_BYTES);
    });

    it('backs off 1 s, 2 s, 4 s … up to 15 s', () => {
        expect([0, 1, 2, 3, 4, 9].map(sessionReconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
    });

    it('reads the CONTRACTS §8 envelope, else a code from the status', () => {
        const error = readSessionError(422, {
            error: { code: 'invalid', hint: 'choose a folder on the computer', details: { field: 'cwd' } },
        });
        expect(error).toMatchObject({ code: 'invalid', hint: 'choose a folder on the computer' });
        expect(errorField(error)).toBe('cwd');
        expect(readSessionError(404, 'nope').code).toBe('not_found');
        expect(readSessionError(500, null).code).toBe('internal');
    });
});

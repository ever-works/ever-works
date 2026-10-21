import { FLEET_SESSION_MAX_OWNER_PER_NODE, FLEET_SESSION_MAX_VIEWERS } from '@ever-works/contracts';
import {
    applyFleetSessionEvent,
    canAttachFleetSession,
    canStartFleetSession,
    endFleetSessionPatch,
    fleetSessionOutcomeForEnd,
    type FleetSessionRowFacts,
    type FleetSessionStartFacts,
} from '../fleet-session.policy';

/**
 * The FL-04 start / attach truth tables and the CONTRACTS §5.1 state moves.
 * Each refusal is checked for its CONTRACTS §8 code AND its hint (the hint
 * is what the person reads: the command to run, who to ask, what to end).
 * `null` is "allowed".
 */

const NOW = new Date('2026-10-18T09:41:00.000Z');

type FactsOverrides = Omit<Partial<FleetSessionStartFacts>, 'node'> & {
    node?: Partial<FleetSessionStartFacts['node']>;
};

function facts(overrides: FactsOverrides = {}): FleetSessionStartFacts {
    const { node, ...rest } = overrides;
    return {
        node: {
            name: 'build-01',
            status: 'online',
            kind: 'node',
            capabilities: ['sessions', 'claude-code', 'codex', 'managed'],
            lastHeartbeatAt: NOW,
            sessionDaemon: { state: 'running', sessions: 0 },
            ...(node ?? {}),
        },
        consents: { work: true, attend: false, manage: true, usageScan: false },
        kind: 'owner',
        provider: 'shell',
        killSwitchOn: false,
        linkConnected: true,
        liveOwnerSessions: [],
        lastSeenAgo: '12 min',
        ...rest,
    };
}

const NO_CONSENTS = { work: false, attend: false, manage: false, usageScan: false };

const listing = (index: number) => ({
    id: `s${index}`,
    title: `session ${index}`,
    startedBy: 'user:u1',
    startedAt: NOW.toISOString(),
});

describe('canStartFleetSession', () => {
    it('allows an owner shell on a managed, connected node with the daemon up', () => {
        expect(canStartFleetSession(facts())).toBeNull();
    });

    it('refuses everything while the kill switch is on, before any other fact', () => {
        expect(
            canStartFleetSession(
                facts({ killSwitchOn: true, linkConnected: false, consents: NO_CONSENTS }),
            ),
        ).toEqual({ code: 'kill_switch', hint: 'clear it under Settings → Fleet' });
    });

    it.each([
        ['paused', 'build-01 is paused — resume it to start sessions'],
        ['disabled', 'build-01 is disabled — enable it to start sessions'],
        ['enrolling', 'build-01 has not finished enrolling'],
    ])('refuses a %s node, naming its state (FR-39)', (status, hint) => {
        expect(canStartFleetSession(facts({ node: { status } }))).toEqual({
            code: 'busy',
            hint,
            details: { nodeState: status },
        });
    });

    it('refuses an owner session without --manage with the exact command (FR-13, U1)', () => {
        expect(
            canStartFleetSession(
                facts({ consents: { work: true, attend: true, manage: false, usageScan: false } }),
            ),
        ).toEqual({
            code: 'consent_missing',
            hint: 'start the node with --manage on build-01',
            details: { consent: 'manage', kind: 'owner' },
        });
    });

    it('refuses an Agent session without --work (FR-46, U2), and allows it with only --work', () => {
        expect(
            canStartFleetSession(
                facts({
                    kind: 'agent',
                    consents: { work: false, attend: false, manage: true, usageScan: false },
                }),
            ),
        ).toMatchObject({
            code: 'consent_missing',
            hint: 'start the node with --work on build-01',
        });
        expect(
            canStartFleetSession(
                facts({
                    kind: 'agent',
                    consents: { work: true, attend: false, manage: false, usageScan: false },
                }),
            ),
        ).toBeNull();
    });

    it('refuses an offline node as unreachable, naming when it was last seen (U4)', () => {
        expect(canStartFleetSession(facts({ linkConnected: false, lastSeenAgo: '2 h' }))).toEqual({
            code: 'unreachable',
            hint: 'build-01 is offline — last seen 2 h ago',
        });
        expect(canStartFleetSession(facts({ linkConnected: false, lastSeenAgo: null }))).toEqual({
            code: 'unreachable',
            hint: 'build-01 is not connected',
        });
    });

    it("refuses when the daemon is not running, quoting the node's own reason (U3)", () => {
        expect(
            canStartFleetSession(
                facts({
                    node: {
                        capabilities: ['claude-code', 'managed'],
                        sessionDaemon: {
                            state: 'failed',
                            reason: 'could not bind the local socket',
                            sessions: 0,
                        },
                    },
                }),
            ),
        ).toEqual({
            code: 'unsupported_on_node',
            hint: 'the session daemon is not running on build-01 — could not bind the local socket',
            details: { daemon: 'failed' },
        });
        expect(
            canStartFleetSession(
                facts({ node: { capabilities: ['managed'], sessionDaemon: null } }),
            ),
        ).toEqual({
            code: 'unsupported_on_node',
            hint: 'the session daemon is not running on build-01',
            details: { daemon: 'unknown' },
        });
    });

    it('refuses a provider the node does not advertise (FR-14), never the shell', () => {
        const node = { capabilities: ['sessions', 'managed'] };
        expect(canStartFleetSession(facts({ provider: 'claude-code', node }))).toEqual({
            code: 'unsupported_on_node',
            hint: 'Claude Code is not installed on build-01',
            details: { provider: 'claude-code' },
        });
        expect(canStartFleetSession(facts({ provider: 'codex', node }))).toMatchObject({
            hint: 'Codex is not installed on build-01',
        });
        expect(canStartFleetSession(facts({ provider: 'shell', node }))).toBeNull();
    });

    it('allows the eighth owner session and refuses the ninth, listing the eight (FR-16, U7)', () => {
        const seven = Array.from({ length: FLEET_SESSION_MAX_OWNER_PER_NODE - 1 }, (_, i) =>
            listing(i),
        );
        expect(canStartFleetSession(facts({ liveOwnerSessions: seven }))).toBeNull();
        const eight = Array.from({ length: FLEET_SESSION_MAX_OWNER_PER_NODE }, (_, i) =>
            listing(i),
        );
        const refusal = canStartFleetSession(facts({ liveOwnerSessions: eight }));
        expect(refusal).toMatchObject({
            code: 'limit_exceeded',
            hint: 'build-01 already has 8 sessions. End one to start another.',
        });
        expect((refusal?.details as { sessions: unknown[] }).sessions).toEqual(eight);
    });

    it('never counts owner sessions against an Agent session (they queue instead)', () => {
        const eight = Array.from({ length: FLEET_SESSION_MAX_OWNER_PER_NODE }, (_, i) =>
            listing(i),
        );
        expect(canStartFleetSession(facts({ kind: 'agent', liveOwnerSessions: eight }))).toBeNull();
    });

    it('refuses a cluster node', () => {
        expect(canStartFleetSession(facts({ node: { kind: 'k8s' } }))).toMatchObject({
            code: 'unsupported_on_node',
        });
    });
});

describe('canAttachFleetSession', () => {
    const base = {
        state: 'working' as const,
        killSwitchOn: false,
        linkConnected: true,
        nodeName: 'build-01',
        attached: [] as string[],
    };

    it('allows the fifth viewer and refuses the sixth, naming the five (FR-24, U8)', () => {
        const four = ['Ops', 'Dana', 'Lee', 'Kai'];
        expect(canAttachFleetSession({ ...base, attached: four })).toBeNull();
        const five = [...four, 'Ana'];
        expect(five).toHaveLength(FLEET_SESSION_MAX_VIEWERS);
        expect(canAttachFleetSession({ ...base, attached: five })).toEqual({
            code: 'limit_exceeded',
            hint: 'This session already has 5 watchers.',
            details: { limit: 5, watchers: five },
        });
    });

    it('refuses under the kill switch, when ended, and when the node is gone', () => {
        expect(canAttachFleetSession({ ...base, killSwitchOn: true })).toMatchObject({
            code: 'kill_switch',
        });
        expect(canAttachFleetSession({ ...base, state: 'ended' })).toMatchObject({
            code: 'invalid',
        });
        expect(canAttachFleetSession({ ...base, linkConnected: false })).toEqual({
            code: 'unreachable',
            hint: 'build-01 is not connected',
        });
    });
});

describe('state transitions (CONTRACTS §5.1)', () => {
    const row = (overrides: Partial<FleetSessionRowFacts> = {}): FleetSessionRowFacts => ({
        state: 'working',
        outcome: null,
        endedReason: null,
        title: 'api tests',
        startedAt: NOW,
        lastScreen: null,
        exitCode: null,
        ...overrides,
    });

    it('moves starting → working on started, stamping startedAt once', () => {
        expect(
            applyFleetSessionEvent(
                row({ state: 'starting', startedAt: null }),
                { event: 'started' },
                NOW,
            ),
        ).toEqual({ state: 'working', startedAt: NOW, lastActivityAt: NOW });
        expect(applyFleetSessionEvent(row(), { event: 'started' }, NOW)).toEqual({
            lastActivityAt: NOW,
        });
    });

    it('wakes an idle session on activity and never ends one on silence', () => {
        expect(applyFleetSessionEvent(row({ state: 'idle' }), { event: 'activity' }, NOW)).toEqual({
            state: 'working',
            lastActivityAt: NOW,
        });
        expect(
            applyFleetSessionEvent(row({ state: 'needs_you' }), { event: 'activity' }, NOW),
        ).toEqual({
            lastActivityAt: NOW,
        });
    });

    it('ends on exit with the code, the screen and the exit outcome (U14)', () => {
        expect(
            applyFleetSessionEvent(row(), { event: 'exited', exitCode: 0, screen: '$ ' }, NOW),
        ).toEqual({
            state: 'ended',
            endedReason: 'exit',
            endedAt: NOW,
            outcome: 'success',
            exitCode: 0,
            lastScreen: '$ ',
        });
        expect(applyFleetSessionEvent(row(), { event: 'exited', exitCode: 1 }, NOW)).toMatchObject({
            outcome: 'failure',
            exitCode: 1,
        });
    });

    it('keeps the reason the node names (drain, kill switch, user)', () => {
        for (const reason of ['drain', 'kill-switch', 'user'] as const) {
            expect(
                applyFleetSessionEvent(row(), { event: 'exited', exitCode: 143, reason }, NOW),
            ).toMatchObject({
                endedReason: reason,
                outcome: 'cancelled',
            });
        }
    });

    it('ends a lost session as node-restart with the persisted screen, outcome unconfirmed (U13)', () => {
        expect(applyFleetSessionEvent(row(), { event: 'lost', screen: 'last' }, NOW)).toEqual({
            state: 'ended',
            endedReason: 'node-restart',
            endedAt: NOW,
            outcome: 'unconfirmed',
            exitCode: null,
            lastScreen: 'last',
        });
    });

    it('keeps an outcome FL-05 already set', () => {
        expect(
            applyFleetSessionEvent(
                row({ outcome: 'success' }),
                { event: 'exited', exitCode: 1 },
                NOW,
            ),
        ).not.toHaveProperty('outcome');
    });

    it('treats ended as terminal but fills in a late exit code and screen', () => {
        const ended = row({ state: 'ended', endedReason: 'user', outcome: 'cancelled' });
        expect(
            applyFleetSessionEvent(ended, { event: 'exited', exitCode: 143, screen: 'bye' }, NOW),
        ).toEqual({
            exitCode: 143,
            lastScreen: 'bye',
        });
        const complete = row({
            state: 'ended',
            endedReason: 'user',
            exitCode: 143,
            lastScreen: 'bye',
        });
        expect(
            applyFleetSessionEvent(
                complete,
                { event: 'exited', exitCode: 0, screen: 'other' },
                NOW,
            ),
        ).toBeNull();
        expect(applyFleetSessionEvent(complete, { event: 'started' }, NOW)).toBeNull();
        expect(applyFleetSessionEvent(complete, { event: 'activity' }, NOW)).toBeNull();
        expect(applyFleetSessionEvent(complete, { event: 'title', title: 'x' }, NOW)).toBeNull();
    });

    it('applies a title only when it changed', () => {
        expect(applyFleetSessionEvent(row(), { event: 'title', title: 'migration' }, NOW)).toEqual({
            title: 'migration',
        });
        expect(
            applyFleetSessionEvent(row(), { event: 'title', title: 'api tests' }, NOW),
        ).toBeNull();
    });

    it('produces every ended reason with its outcome', () => {
        expect(fleetSessionOutcomeForEnd('user', null)).toBe('cancelled');
        expect(fleetSessionOutcomeForEnd('agent', null)).toBe('cancelled');
        expect(fleetSessionOutcomeForEnd('drain', null)).toBe('cancelled');
        expect(fleetSessionOutcomeForEnd('kill-switch', null)).toBe('cancelled');
        expect(fleetSessionOutcomeForEnd('exit', 0)).toBe('success');
        expect(fleetSessionOutcomeForEnd('exit', 2)).toBe('failure');
        expect(fleetSessionOutcomeForEnd('exit', null)).toBe('unconfirmed');
        expect(fleetSessionOutcomeForEnd('node-restart', 0)).toBe('unconfirmed');
        expect(fleetSessionOutcomeForEnd('timeout', null)).toBe('unconfirmed');
    });

    it('does not end an already ended row twice', () => {
        expect(
            endFleetSessionPatch(row({ state: 'ended', endedReason: 'exit' }), 'user', NOW),
        ).toBeNull();
    });
});

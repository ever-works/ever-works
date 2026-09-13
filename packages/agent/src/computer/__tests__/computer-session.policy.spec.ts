import { nodeSatisfiesCapabilities, type FleetNodeView } from '@ever-works/contracts';
import {
    COMPUTER_AUTO_REFRESH_AFTER_MS,
    COMPUTER_DEAD_AFTER_MS,
    COMPUTER_DEGRADE_WINDOW_MS,
    COMPUTER_RECOVER_WINDOW_MS,
    COMPUTER_SESSION_LIMIT_DEFAULTS,
    COMPUTER_STALL_AFTER_MS,
    defaultChannelsFor,
    degradedQuality,
    requiredCapabilitiesForChannels,
    resolveComputerChannels,
    resolveComputerSessionLimits,
    resolveQuality,
    resolveSessionExpiry,
    resolveWatchability,
    shouldDegrade,
    shouldRecover,
    stallState,
} from '../computer-session.policy';

/**
 * The live-view rules, as a truth table. Each branch is one decision an
 * owner sees the result of: which machine they may watch and the one reason
 * they may not, and when a quiet stream stops being "slow" and becomes over.
 */
function node(overrides: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'n1',
        name: 'studio',
        kind: 'desktop-node',
        status: 'online',
        platform: 'darwin/arm64',
        version: '1.0.0',
        capabilities: ['terminal', 'workspace', 'browser', 'screen', 'attended'],
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: null,
        persisted: true,
        ...overrides,
    };
}

describe('resolveWatchability', () => {
    it.each<[string, Partial<FleetNodeView>, string | null]>([
        ['an online, attended node with a capture backend', {}, null],
        ['a cluster node', { kind: 'k8s', persisted: false }, 'cluster'],
        ['a disabled node', { status: 'disabled' }, 'disabled'],
        ['a paused node', { status: 'paused' }, 'paused'],
        ['a node whose worker is winding down', { workerState: 'paused' }, 'draining'],
        ['a quarantined worker', { workerState: 'quarantined' }, 'draining'],
        ['an offline node', { status: 'offline' }, 'offline'],
        ['an enrolling node', { status: 'enrolling' }, 'offline'],
        [
            'a node live viewing was never switched on for',
            { capabilities: ['browser', 'screen'] },
            'not-attended',
        ],
        [
            'a node with a browser, no capture backend and no shell',
            { capabilities: ['browser', 'attended'] },
            'no-display',
        ],
        ['a node with no browser and no shell', { capabilities: ['attended'] }, 'no-browser'],
        [
            'a node with a browser but no capture backend, and a shell',
            { capabilities: ['browser', 'terminal', 'attended'] },
            null,
        ],
        [
            'a node with a capture backend but no shell',
            { capabilities: ['screen', 'attended'] },
            null,
        ],
    ])('%s', (_label, overrides, reason) => {
        const verdict = resolveWatchability(node(overrides));
        expect(verdict.reason).toBe(reason);
        expect(verdict.watchable).toBe(reason === null);
        expect(verdict.servableChannels.length > 0).toBe(reason === null);
    });

    it('takes only the screen away for no-browser and no-display, and only the terminal for no-terminal', () => {
        expect(resolveWatchability(node({ capabilities: ['terminal', 'attended'] }))).toEqual({
            watchable: true,
            reason: null,
            servableChannels: ['terminal'],
            channelReasons: { screen: 'no-browser' },
        });
        expect(
            resolveWatchability(node({ capabilities: ['browser', 'terminal', 'attended'] })),
        ).toEqual({
            watchable: true,
            reason: null,
            servableChannels: ['terminal'],
            channelReasons: { screen: 'no-display' },
        });
        expect(resolveWatchability(node({ capabilities: ['screen', 'attended'] }))).toEqual({
            watchable: true,
            reason: null,
            servableChannels: ['screen'],
            channelReasons: { terminal: 'no-terminal' },
        });
        expect(resolveWatchability(node())).toEqual({
            watchable: true,
            reason: null,
            servableChannels: ['screen', 'terminal'],
            channelReasons: {},
        });
    });

    it('refuses every channel for a whole-machine reason', () => {
        expect(resolveWatchability(node({ status: 'offline' }))).toEqual({
            watchable: false,
            reason: 'offline',
            servableChannels: [],
            channelReasons: {},
        });
    });

    it('names the thing to fix FIRST when several are wrong', () => {
        expect(resolveWatchability(node({ status: 'disabled', capabilities: [] })).reason).toBe(
            'disabled',
        );
        expect(resolveWatchability(node({ status: 'offline', capabilities: [] })).reason).toBe(
            'offline',
        );
        expect(
            resolveWatchability(node({ kind: 'k8s', persisted: false, status: 'disabled' })).reason,
        ).toBe('cluster');
    });
});

describe('resolveComputerChannels', () => {
    it('offers only what the machine advertises, and nothing on an unattended machine', () => {
        expect(resolveComputerChannels(node())).toEqual(['screen', 'terminal']);
        expect(resolveComputerChannels(node({ capabilities: ['terminal', 'attended'] }))).toEqual([
            'terminal',
        ]);
        expect(resolveComputerChannels(node({ capabilities: ['terminal'] }))).toEqual([]);
        expect(resolveComputerChannels(node({ capabilities: [] }))).toEqual([]);
    });
});

describe('requiredCapabilitiesForChannels', () => {
    it.each<[Array<'screen' | 'terminal'>, string[]]>([
        [['screen'], ['attended', 'screen']],
        [['terminal'], ['attended', 'terminal']],
        [
            ['screen', 'terminal'],
            ['attended', 'screen', 'terminal'],
        ],
        [
            ['terminal', 'screen'],
            ['attended', 'screen', 'terminal'],
        ],
    ])('%o requires %o', (channels, tags) => {
        expect(requiredCapabilitiesForChannels(channels)).toEqual(tags);
    });

    it('never asks a terminal-only session for a screen, and always asks for attended', () => {
        expect(requiredCapabilitiesForChannels(['terminal'])).not.toContain('screen');
        for (const channels of [['screen'], ['terminal'], ['screen', 'terminal']] as const) {
            expect(requiredCapabilitiesForChannels(channels)).toContain('attended');
        }
    });

    it('feeds the real lease matcher: a headless attended machine takes a terminal session only', () => {
        const headless = ['terminal', 'workspace', 'attended'];
        expect(
            nodeSatisfiesCapabilities(headless, requiredCapabilitiesForChannels(['terminal'])),
        ).toBe(true);
        expect(
            nodeSatisfiesCapabilities(headless, requiredCapabilitiesForChannels(['screen'])),
        ).toBe(false);

        const unattended = ['terminal', 'workspace'];
        expect(
            nodeSatisfiesCapabilities(unattended, requiredCapabilitiesForChannels(['terminal'])),
        ).toBe(false);
        expect(
            nodeSatisfiesCapabilities(unattended, requiredCapabilitiesForChannels(['screen'])),
        ).toBe(false);
    });
});

describe('defaultChannelsFor', () => {
    it('opens the screen when it can, else the terminal, else nothing', () => {
        expect(defaultChannelsFor(['screen', 'terminal'])).toEqual(['screen']);
        expect(defaultChannelsFor(['terminal'])).toEqual(['terminal']);
        expect(defaultChannelsFor([])).toEqual([]);
    });
});

describe('quality', () => {
    it('prefers the request, then the stored value, then sharp', () => {
        expect(resolveQuality('steady', 'smooth')).toBe('steady');
        expect(resolveQuality(undefined, 'smooth')).toBe('smooth');
        expect(resolveQuality('ultra', 'nope')).toBe('sharp');
    });

    it('degrades only after the full window over a limit, one tier at a time', () => {
        const slow = { backlog: 4, ackMs: 100 };
        expect(shouldDegrade(slow, COMPUTER_DEGRADE_WINDOW_MS - 1)).toBe(false);
        expect(shouldDegrade(slow, COMPUTER_DEGRADE_WINDOW_MS)).toBe(true);
        expect(shouldDegrade({ backlog: 0, ackMs: 1501 }, COMPUTER_DEGRADE_WINDOW_MS)).toBe(true);
        expect(shouldDegrade({ backlog: 3, ackMs: 1500 }, COMPUTER_DEGRADE_WINDOW_MS)).toBe(false);
        expect(degradedQuality('sharp')).toBe('smooth');
    });

    it('recovers only after thirty continuous seconds within limits', () => {
        const fine = { backlog: 0, ackMs: 40 };
        expect(shouldRecover(fine, COMPUTER_RECOVER_WINDOW_MS - 1)).toBe(false);
        expect(shouldRecover(fine, COMPUTER_RECOVER_WINDOW_MS)).toBe(true);
        expect(shouldRecover({ backlog: 9, ackMs: 40 }, COMPUTER_RECOVER_WINDOW_MS)).toBe(false);
    });
});

describe('stallState', () => {
    const now = new Date('2026-09-13T10:00:00.000Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);

    it.each<[number, string]>([
        [COMPUTER_STALL_AFTER_MS - 1, 'ok'],
        [COMPUTER_STALL_AFTER_MS, 'stalled'],
        [COMPUTER_AUTO_REFRESH_AFTER_MS - 1, 'stalled'],
        [COMPUTER_AUTO_REFRESH_AFTER_MS, 'auto-refresh'],
        [COMPUTER_DEAD_AFTER_MS - 1, 'auto-refresh'],
        [COMPUTER_DEAD_AFTER_MS, 'dead'],
    ])('a picture %d ms old is %s', (age, state) => {
        expect(stallState(ago(age), now)).toBe(state);
    });

    it('treats a stream that never produced a picture as not stalled (the claim timeout owns that case)', () => {
        expect(stallState(null, now)).toBe('ok');
    });
});

describe('session limits', () => {
    it('defaults to 2 per node, 5 per Organization, 4 hours, 40 s to claim', () => {
        expect(resolveComputerSessionLimits({})).toEqual(COMPUTER_SESSION_LIMIT_DEFAULTS);
        expect(COMPUTER_SESSION_LIMIT_DEFAULTS).toMatchObject({
            perNode: 2,
            perOrganization: 5,
            maxDurationMs: 4 * 3_600_000,
            claimTimeoutMs: 40_000,
            lastViewerGraceMs: 15_000,
            noViewerMs: 30 * 60_000,
        });
    });

    it('clamps operator values and never lets a value switch a cap off', () => {
        const limits = resolveComputerSessionLimits({
            COMPUTER_SESSION_MAX_PER_NODE: '0',
            COMPUTER_SESSION_MAX_PER_ORGANIZATION: '500',
            COMPUTER_SESSION_MAX_DURATION_MINUTES: '5',
        });
        expect(limits.perNode).toBe(1);
        expect(limits.perOrganization).toBe(50);
        expect(limits.maxDurationMs).toBe(15 * 60_000);
        expect(
            resolveComputerSessionLimits({ COMPUTER_SESSION_MAX_PER_NODE: 'lots' }).perNode,
        ).toBe(2);
    });

    it.each(['2oops', '2.9', '', '   ', '0x4', '1e1', '4 per node'])(
        'treats the partially numeric value %p as unset, not as a limit',
        (raw) => {
            const limits = resolveComputerSessionLimits({
                COMPUTER_SESSION_MAX_PER_NODE: raw,
                COMPUTER_SESSION_MAX_PER_ORGANIZATION: raw,
                COMPUTER_SESSION_MAX_DURATION_MINUTES: raw,
            });
            expect(limits).toEqual(COMPUTER_SESSION_LIMIT_DEFAULTS);
        },
    );

    it('accepts a whole integer with surrounding whitespace or an explicit sign', () => {
        expect(resolveComputerSessionLimits({ COMPUTER_SESSION_MAX_PER_NODE: ' 3 ' }).perNode).toBe(
            3,
        );
        expect(
            resolveComputerSessionLimits({ COMPUTER_SESSION_MAX_PER_ORGANIZATION: '+7' })
                .perOrganization,
        ).toBe(7);
        expect(resolveComputerSessionLimits({ COMPUTER_SESSION_MAX_PER_NODE: '-4' }).perNode).toBe(
            1,
        );
    });
});

describe('resolveSessionExpiry', () => {
    const now = new Date('2026-09-13T10:00:00.000Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const limits = COMPUTER_SESSION_LIMIT_DEFAULTS;

    it('abandons a view no machine claimed within the claim timeout, at the boundary', () => {
        expect(
            resolveSessionExpiry({ status: 'requested', createdAt: ago(39_999) }, now, limits),
        ).toBeNull();
        expect(
            resolveSessionExpiry({ status: 'requested', createdAt: ago(40_000) }, now, limits),
        ).toBe('abandoned');
    });

    it('ends a live view at the ceiling, and a silent one once it is dead', () => {
        expect(
            resolveSessionExpiry(
                { status: 'live', startedAt: ago(limits.maxDurationMs), lastFrameAt: ago(10) },
                now,
                limits,
            ),
        ).toBe('session-ceiling');
        expect(
            resolveSessionExpiry(
                {
                    status: 'stalled',
                    startedAt: ago(60_000),
                    lastFrameAt: ago(COMPUTER_DEAD_AFTER_MS),
                },
                now,
                limits,
            ),
        ).toBe('stalled');
        expect(
            resolveSessionExpiry(
                { status: 'live', startedAt: ago(60_000), lastFrameAt: ago(1000) },
                now,
                limits,
            ),
        ).toBeNull();
    });

    it('never expires an ended session again', () => {
        expect(
            resolveSessionExpiry({ status: 'ended', createdAt: ago(10 * 3_600_000) }, now, limits),
        ).toBeNull();
    });
});

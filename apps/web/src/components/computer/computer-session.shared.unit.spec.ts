import { describe, expect, it } from 'vitest';
import type { ComputerNodeOption } from '@ever-works/contracts';
import {
    buildComputerViewHref,
    closeReasonKey,
    COMPUTER_CLOCK_STALE_AFTER_MS,
    COMPUTER_CONNECTING_SLOW_AFTER_MS,
    computerStallAgeMs,
    computerStallStateForAge,
    connectingPhase,
    describeOpenRefusal,
    formatBandwidth,
    isNodeClockStale,
    isQualityLowered,
    nextQuality,
    nodeClockDisplay,
    nodeReasonKey,
    nodeRowNote,
    qualityStorageKey,
    readStoredQuality,
    resolveChannel,
    resolvePreOpenState,
    selectInitialNode,
    writeStoredQuality,
} from './computer-session.shared';

function node(over: Partial<ComputerNodeOption> = {}): ComputerNodeOption {
    return {
        id: 'node-1',
        name: 'studio-imac',
        kind: 'desktop-node',
        status: 'online',
        platform: 'darwin/arm64',
        lastHeartbeatAt: '2026-09-13T09:41:00.000Z',
        servableChannels: ['screen', 'terminal'],
        channelReasons: {},
        watchable: true,
        unwatchableReason: null,
        boundToAgent: false,
        controlPolicy: 'owner',
        ...over,
    };
}

const noStop = { stopped: false, reason: null, since: null };

describe('selectInitialNode', () => {
    it('opens the computer in the link, else the Agent’s pinned one, else the first watchable', () => {
        const a = node({
            id: 'a',
            watchable: false,
            unwatchableReason: 'offline',
            servableChannels: [],
        });
        const b = node({ id: 'b' });
        const pinned = node({ id: 'pinned', boundToAgent: true });
        expect(selectInitialNode([a, b, pinned], 'b')?.id).toBe('b');
        expect(selectInitialNode([a, b, pinned], 'unknown')?.id).toBe('pinned');
        expect(selectInitialNode([a, b], null)?.id).toBe('b');
        expect(selectInitialNode([a], null)?.id).toBe('a');
        expect(selectInitialNode([], null)).toBeNull();
    });
});

describe('resolvePreOpenState — every node shape', () => {
    it('says the list could not be loaded rather than claiming there are no computers', () => {
        expect(
            resolvePreOpenState({ nodes: null, node: null, requestedChannel: null, stop: null }),
        ).toEqual({ kind: 'nodes-unavailable' });
        expect(
            resolvePreOpenState({ nodes: [], node: null, requestedChannel: null, stop: null }),
        ).toEqual({ kind: 'empty' });
    });

    it('puts the fleet stop ahead of every computer state', () => {
        const state = resolvePreOpenState({
            nodes: [node()],
            node: node(),
            requestedChannel: null,
            stop: {
                stopped: true,
                reason: 'Investigating a runaway job',
                since: '2026-09-13T08:55:00Z',
            },
        });
        expect(state).toEqual({
            kind: 'stopped',
            reason: 'Investigating a runaway job',
            since: '2026-09-13T08:55:00Z',
        });
    });

    it.each([
        ['offline', 'offline'],
        ['not-attended', 'not-attended'],
        ['paused', 'unwatchable'],
        ['disabled', 'unwatchable'],
        ['draining', 'unwatchable'],
        ['cluster', 'unwatchable'],
    ] as const)('maps an unwatchable computer (%s) to the %s state', (reason, kind) => {
        const option = node({ watchable: false, unwatchableReason: reason, servableChannels: [] });
        expect(
            resolvePreOpenState({
                nodes: [option],
                node: option,
                requestedChannel: null,
                stop: noStop,
            }).kind,
        ).toBe(kind);
    });

    it('treats a computer with neither channel as "cannot show", naming the screen’s reason', () => {
        const option = node({
            watchable: false,
            unwatchableReason: 'no-browser',
            servableChannels: [],
            channelReasons: { screen: 'no-browser', terminal: 'no-terminal' },
        });
        expect(
            resolvePreOpenState({
                nodes: [option],
                node: option,
                requestedChannel: null,
                stop: noStop,
            }),
        ).toMatchObject({
            kind: 'channel-unavailable',
            channel: 'screen',
            reason: 'no-browser',
            alternative: null,
        });
    });

    it('lists a display-less computer as watchable on its terminal only, offering it instead of the screen', () => {
        const headless = node({
            servableChannels: ['terminal'],
            channelReasons: { screen: 'no-display' },
        });
        expect(
            resolvePreOpenState({
                nodes: [headless],
                node: headless,
                requestedChannel: null,
                stop: noStop,
            }),
        ).toMatchObject({
            kind: 'ready',
            channel: 'terminal',
        });
        expect(
            resolvePreOpenState({
                nodes: [headless],
                node: headless,
                requestedChannel: 'screen',
                stop: noStop,
            }),
        ).toMatchObject({
            kind: 'channel-unavailable',
            channel: 'screen',
            reason: 'no-display',
            alternative: 'terminal',
        });
    });

    it('opens the screen by default and honours a channel in the link', () => {
        const option = node();
        expect(
            resolvePreOpenState({
                nodes: [option],
                node: option,
                requestedChannel: null,
                stop: noStop,
            }),
        ).toMatchObject({ kind: 'ready', channel: 'screen' });
        expect(
            resolvePreOpenState({
                nodes: [option],
                node: option,
                requestedChannel: 'terminal',
                stop: noStop,
            }),
        ).toMatchObject({ kind: 'ready', channel: 'terminal' });
        expect(resolveChannel(option, 'nonsense')).toBe('screen');
    });
});

describe('picker row notes', () => {
    it('names every closed-set reason with its own key', () => {
        expect(nodeReasonKey('offline')).toBe('reasonOffline');
        expect(nodeReasonKey('no-display')).toBe('reasonNoDisplay');
        expect(nodeReasonKey('no-browser')).toBe('reasonNoBrowser');
        expect(nodeReasonKey('no-terminal')).toBe('reasonNoTerminal');
        expect(nodeReasonKey('not-attended')).toBe('reasonNotAttended');
        expect(nodeReasonKey('cluster')).toBe('reasonCluster');
        expect(nodeReasonKey('draining')).toBe('reasonDraining');
    });

    it('shows what a watchable computer serves, and the other channel’s reason beside it', () => {
        expect(nodeRowNote(node())).toEqual({
            key: 'capabilitiesScreenTerminal',
            tone: 'ok',
            missingKey: null,
        });
        expect(
            nodeRowNote(
                node({ servableChannels: ['terminal'], channelReasons: { screen: 'no-browser' } }),
            ),
        ).toEqual({
            key: 'capabilitiesTerminal',
            tone: 'ok',
            missingKey: 'reasonNoBrowser',
        });
        expect(
            nodeRowNote(
                node({ watchable: false, unwatchableReason: 'paused', servableChannels: [] }),
            ),
        ).toEqual({
            key: 'reasonPaused',
            tone: 'muted',
            missingKey: null,
        });
    });
});

describe('quality', () => {
    it('persists per computer and falls back to sharp when storage is unreadable', () => {
        const store = new Map<string, string>();
        const storage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
        };
        expect(readStoredQuality(storage, 'node-1')).toBe('sharp');
        writeStoredQuality(storage, 'node-1', 'steady');
        expect(store.get(qualityStorageKey('node-1'))).toBe('steady');
        expect(readStoredQuality(storage, 'node-1')).toBe('steady');
        expect(readStoredQuality(storage, 'node-2')).toBe('sharp');

        const broken = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };
        expect(readStoredQuality(broken, 'node-1')).toBe('sharp');
        expect(() => writeStoredQuality(broken, 'node-1', 'smooth')).not.toThrow();
        store.set(qualityStorageKey('node-3'), 'ultra');
        expect(readStoredQuality(storage, 'node-3')).toBe('sharp');
    });

    it('cycles Sharp → Smooth → Steady → Sharp and says when the machine lowered it', () => {
        expect(nextQuality('sharp')).toBe('smooth');
        expect(nextQuality('smooth')).toBe('steady');
        expect(nextQuality('steady')).toBe('sharp');
        expect(isQualityLowered({ quality: 'sharp', effectiveQuality: 'steady' })).toBe(true);
        expect(isQualityLowered({ quality: 'sharp', effectiveQuality: 'sharp' })).toBe(false);
        expect(isQualityLowered(null)).toBe(false);
    });
});

describe('stall, clock and connecting thresholds', () => {
    it('reads the shared stall ladder at its boundaries', () => {
        expect(computerStallStateForAge(null)).toBe('ok');
        expect(computerStallStateForAge(5999)).toBe('ok');
        expect(computerStallStateForAge(6000)).toBe('stalled');
        expect(computerStallStateForAge(20_000)).toBe('auto-refresh');
        expect(computerStallStateForAge(45_000)).toBe('dead');
    });

    it('runs the stall ladder for a live screen only — a quiet terminal is a healthy prompt', () => {
        const at = { lastFrameAt: 1000, now: 1000 + 50_000 };
        expect(computerStallAgeMs({ channel: 'screen', live: true, ...at })).toBe(50_000);
        expect(
            computerStallStateForAge(computerStallAgeMs({ channel: 'screen', live: true, ...at })),
        ).toBe('dead');
        expect(computerStallAgeMs({ channel: 'terminal', live: true, ...at })).toBeNull();
        expect(
            computerStallStateForAge(
                computerStallAgeMs({ channel: 'terminal', live: true, ...at }),
            ),
        ).toBe('ok');
        expect(computerStallAgeMs({ channel: 'screen', live: false, ...at })).toBeNull();
        expect(
            computerStallAgeMs({ channel: 'screen', live: true, lastFrameAt: null, now: 5 }),
        ).toBeNull();
        expect(computerStallAgeMs({ channel: null, live: true, ...at })).toBeNull();
    });

    it('shows the machine’s own clock and marks it stale after ten silent seconds', () => {
        expect(nodeClockDisplay('2026-09-13T09:41:07+03:00')).toBe('09:41:07');
        expect(nodeClockDisplay(null)).toBeNull();
        expect(isNodeClockStale(1000, 1000 + COMPUTER_CLOCK_STALE_AFTER_MS)).toBe(false);
        expect(isNodeClockStale(1000, 1001 + COMPUTER_CLOCK_STALE_AFTER_MS)).toBe(true);
        expect(isNodeClockStale(null, 0)).toBe(true);
    });

    it('turns "waking up" into "has not answered yet" at twenty seconds', () => {
        expect(connectingPhase(COMPUTER_CONNECTING_SLOW_AFTER_MS - 1)).toBe('waking');
        expect(connectingPhase(COMPUTER_CONNECTING_SLOW_AFTER_MS)).toBe('slow');
    });

    it('formats bandwidth, zero included', () => {
        expect(formatBandwidth(undefined)).toBe('0 B');
        expect(formatBandwidth(12_400_000)).toBe('12 MB');
    });
});

describe('describeOpenRefusal', () => {
    it('maps each named refusal from the platform to its own state', () => {
        expect(
            describeOpenRefusal(409, {
                reason: 'stopped',
                stop: { reason: 'Maintenance', since: 'x' },
            }),
        ).toEqual({
            kind: 'stopped',
            reason: 'Maintenance',
            since: 'x',
        });
        expect(describeOpenRefusal(409, { reason: 'no-nodes' })).toEqual({ kind: 'empty' });
        expect(describeOpenRefusal(409, { reason: 'draining' })).toEqual({
            kind: 'unwatchable',
            reason: 'draining',
        });
        expect(describeOpenRefusal(422, { reason: 'no-display', channel: 'screen' })).toEqual({
            kind: 'channel-unavailable',
            channel: 'screen',
            reason: 'no-display',
        });
        expect(
            describeOpenRefusal(429, {
                reason: 'node-session-cap',
                limit: 2,
                sessions: [{ sessionId: 's' }],
            }),
        ).toMatchObject({
            kind: 'over-limit',
            scope: 'node',
            limit: 2,
        });
        expect(describeOpenRefusal(404, null)).toEqual({ kind: 'refused' });
        expect(describeOpenRefusal(503, { reason: 'dispatcher-unavailable' })).toEqual({
            kind: 'unavailable',
        });
        expect(describeOpenRefusal(500, 'garbage')).toEqual({ kind: 'cannot-connect' });
    });

    it('names every close reason', () => {
        expect(closeReasonKey('closed-by-user')).toBe('closedByUser');
        expect(closeReasonKey('node-restarted')).toBe('nodeRestarted');
        expect(closeReasonKey('abandoned')).toBe('abandoned');
        expect(closeReasonKey(null)).toBe('error');
    });
});

describe('buildComputerViewHref', () => {
    it('links to one computer and channel so a view can be shared or bookmarked', () => {
        expect(buildComputerViewHref('agent-1')).toBe('/agents/agent-1/computer');
        expect(buildComputerViewHref('agent-1', 'node-1', 'terminal')).toBe(
            '/agents/agent-1/computer?node=node-1&channel=terminal',
        );
    });
});

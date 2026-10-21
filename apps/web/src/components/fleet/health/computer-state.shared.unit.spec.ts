import { describe, expect, it } from 'vitest';
import {
    COMPUTER_STATES,
    FLEET_NODE_CLEAR_QUARANTINE_COMMAND,
    type ComputerStateResolution,
    type FleetNodeView,
} from '@ever-works/contracts';
import messages from '../../../../messages/en.json';
import {
    cliDisplayName,
    computerStateCopy,
    computerStateCopyFor,
    formatBinaryBytes,
    formatInstant,
    formatMiB,
    preferredStateResolution,
    stateDotClass,
    stateKey,
    uptimeCopy,
} from './computer-state.shared';

const GIB = 1024 ** 3;

function node(overrides: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'n1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '0.3.0',
        capabilities: ['claude-code'],
        lastHeartbeatAt: '2026-10-18T09:40:00.000Z',
        createdAt: null,
        persisted: true,
        ...overrides,
    };
}

/**
 * Computer health (FL-03) — the presentation of a computer's state. The state
 * itself is `resolveComputerState` (truth table pinned in contracts); this pins
 * that every state has a word and a sentence in `en.json`, and that each
 * sentence variant gets exactly the values it interpolates.
 */
describe('computer-state.shared', () => {
    it('every one of the eleven states has a word, a sentence and a dot that is not colour alone', () => {
        const fleet = (
            messages as unknown as {
                fleet: { states: Record<string, string>; stateSentences: Record<string, string> };
            }
        ).fleet;
        for (const state of COMPUTER_STATES) {
            const key = stateKey(state);
            expect(fleet.states[key], state).toBeTruthy();
            expect(fleet.stateSentences[key], state).toBeTruthy();
            expect(stateDotClass(state)).toMatch(/^bg-/);
        }
        expect(stateKey('upgrade-required')).toBe('upgradeRequired');
    });

    it('every sentence variant the helper can choose exists in en.json', () => {
        const sentences = (
            messages as unknown as { fleet: { stateSentences: Record<string, string> } }
        ).fleet.stateSentences;
        const variants: ComputerStateResolution[] = [
            { state: 'busy', params: {}, action: null },
            { state: 'offline', params: {}, action: null },
            { state: 'quarantined', params: {}, action: null },
            { state: 'throttled', params: {}, action: null },
            {
                state: 'throttled',
                params: { dimension: 'cpu', value: 92, limit: 85 },
                action: null,
            },
            {
                state: 'throttled',
                params: { dimension: 'memory', value: 7000, limit: 6000 },
                action: null,
            },
            {
                state: 'throttled',
                params: { dimension: 'disk', value: 3 * GIB, limit: 5 * GIB },
                action: null,
            },
            {
                state: 'limited',
                params: { provider: 'codex', until: 'x', limitedCount: 2 },
                action: null,
            },
        ];
        for (const variant of variants) {
            expect(sentences[computerStateCopy(variant).sentenceKey]).toBeTruthy();
        }
    });

    it('busy names its job count, or says only "Busy" when the count is unknown', () => {
        expect(
            computerStateCopy({ state: 'busy', params: { jobs: 2 }, action: null }),
        ).toMatchObject({
            sentenceKey: 'busy',
            values: { jobs: 2 },
        });
        expect(computerStateCopy({ state: 'busy', params: {}, action: null }).sentenceKey).toBe(
            'busyNoCount',
        );
    });

    it('offline carries the last beat for "last seen …", or the bare word without one', () => {
        expect(
            computerStateCopy({
                state: 'offline',
                params: { lastSeenAt: '2026-10-18T07:00:00.000Z' },
                action: null,
            }).values,
        ).toEqual({ lastSeenAt: '2026-10-18T07:00:00.000Z' });
        expect(
            computerStateCopy({ state: 'offline', params: { lastSeenAt: null }, action: null })
                .sentenceKey,
        ).toBe('offlineNever');
    });

    it('throttled picks the dimension sentence and formats the disk pair in binary bytes', () => {
        expect(
            computerStateCopy({
                state: 'throttled',
                params: { dimension: 'cpu', value: 92, limit: 85 },
                action: null,
            }),
        ).toMatchObject({ sentenceKey: 'throttledCpu', values: { value: 92, limit: 85 } });
        expect(
            computerStateCopy({
                state: 'throttled',
                params: { dimension: 'disk', value: 3 * GIB, limit: 5 * GIB },
                action: null,
            }).values,
        ).toEqual({ value: '3 GiB', limit: '5 GiB' });
        expect(
            computerStateCopy({ state: 'throttled', params: { reason: 'x' }, action: null }),
        ).toMatchObject({
            sentenceKey: 'throttled',
            values: { reason: 'x' },
        });
    });

    it('limited names the CLI as people say it and keeps the reset instant raw for the viewer’s zone', () => {
        const copy = computerStateCopyFor(
            node({
                workerState: 'throttled',
                modelThrottles: [
                    {
                        provider: 'claude-code',
                        window: 'weekly',
                        until: '2099-10-19T01:00:00.000Z',
                        reason: 'x',
                        since: 'y',
                    },
                ],
            }),
            { now: Date.parse('2026-10-18T09:41:00Z') },
        );
        expect(copy).toMatchObject({
            state: 'limited',
            sentenceKey: 'limited',
            values: { cli: 'Claude Code', until: '2099-10-19T01:00:00.000Z' },
            action: { kind: 'clear-model-throttle', provider: 'claude-code' },
        });
    });

    it('quarantined carries the machine command as its fix', () => {
        expect(computerStateCopyFor(node({ workerState: 'quarantined' })).action).toEqual({
            kind: 'copy-command',
            command: FLEET_NODE_CLEAR_QUARANTINE_COMMAND,
        });
    });

    it('formats bytes in binary units and never turns an unknown figure into 0', () => {
        expect(formatBinaryBytes(6 * GIB)).toBe('6 GiB');
        expect(formatBinaryBytes(1.5 * GIB)).toBe('1.5 GiB');
        expect(formatBinaryBytes(118 * GIB)).toBe('118 GiB');
        expect(formatBinaryBytes(512 * 1024 ** 2)).toBe('512 MiB');
        expect(formatBinaryBytes(null)).toBeNull();
        expect(formatBinaryBytes(-1)).toBeNull();
        expect(formatMiB(9523)).toBe('9.3 GiB');
        expect(formatMiB(undefined)).toBeNull();
    });

    it('uptime reads as days and hours, hours and minutes, or minutes', () => {
        expect(uptimeCopy(3 * 86_400 + 4 * 3_600 + 59)).toEqual({
            key: 'days',
            values: { days: 3, hours: 4 },
        });
        expect(uptimeCopy(2 * 3_600 + 5 * 60)).toEqual({
            key: 'hours',
            values: { hours: 2, minutes: 5 },
        });
        expect(uptimeCopy(42)).toEqual({ key: 'minutes', values: { minutes: 0 } });
        expect(uptimeCopy(null)).toBeNull();
    });

    it('formats a reset instant locally, with the same instant in UTC for the tooltip', () => {
        const instant = formatInstant('2026-10-19T01:00:00.000Z', 'en-GB');
        expect(instant?.utc).toContain('01:00');
        expect(instant?.local).toBeTruthy();
        expect(formatInstant('not a date', 'en-GB')).toBeNull();
    });

    it('names the CLIs as people say them and passes others through', () => {
        expect(cliDisplayName('claude-code')).toBe('Claude Code');
        expect(cliDisplayName('codex')).toBe('Codex');
        expect(cliDisplayName('gemini')).toBe('gemini');
    });
});

/**
 * The footer runner pill (`runnerRowState`) and the Fleet state
 * (`resolveComputerState`) must name the same state for the same registry
 * facts — both real functions, imported, so changing either one fails here.
 */
describe('resolveComputerState agrees with the footer runner pill', () => {
    it('for every registry status, idle and busy, when no worker fact overrides it', async () => {
        const { resolveComputerState } = await import('@ever-works/contracts');
        const { runnerRowState } = await import('@/components/dashboard/runner-status.shared');
        const statuses: FleetNodeView['status'][] = [
            'enrolling',
            'online',
            'offline',
            'paused',
            'disabled',
        ];
        let compared = 0;
        for (const status of statuses) {
            for (const busy of [false, true]) {
                // A disabled node still holding jobs is the one deliberate refinement: draining.
                if (status === 'disabled' && busy) continue;
                const pill = runnerRowState({
                    id: 'n1',
                    name: 'build-01',
                    kind: 'node',
                    status,
                    lastHeartbeatAt: null,
                    daemonVersion: null,
                    cliVersion: null,
                    diskFreeBytes: null,
                    busy,
                } as Parameters<typeof runnerRowState>[0]);
                const state = resolveComputerState(
                    node({
                        status,
                        load: {
                            activeJobCount: busy ? 1 : 0,
                            currentJobKind: null,
                            currentJobId: null,
                        },
                    }),
                ).state;
                expect(state, `${status}${busy ? ' busy' : ''}`).toBe(pill);
                compared += 1;
            }
        }
        expect(compared).toBe(9);
    });
});

describe('preferredStateResolution — the server’s state, unless the clock alone has made it stale', () => {
    const NOW = Date.parse('2026-10-18T09:41:00.000Z');

    it('shows the server’s judgement over the browser’s own (offline window, job count)', () => {
        const server: ComputerStateResolution = {
            state: 'offline',
            params: { lastSeenAt: '2026-10-18T08:00:00.000Z' },
            action: null,
        };
        // The row the page holds still says online: the server knows better.
        expect(preferredStateResolution(server, node(), { now: NOW })).toBe(server);
    });

    it('a limit whose reset has passed is the browser’s to judge — it drops the expired limit', () => {
        const server: ComputerStateResolution = {
            state: 'limited',
            params: { provider: 'claude-code', until: '2026-10-18T09:00:00.000Z', limitedCount: 1 },
            action: { kind: 'clear-model-throttle', provider: 'claude-code' },
        };
        const expired = node({
            modelThrottles: [
                {
                    provider: 'claude-code',
                    window: 'weekly',
                    until: '2026-10-18T09:00:00.000Z',
                    reason: 'weekly limit',
                    since: '2026-10-18T03:00:00.000Z',
                },
            ],
        });
        expect(preferredStateResolution(server, expired, { now: NOW }).state).toBe('online');
        // Still in force: the server’s answer stands.
        expect(
            preferredStateResolution(server, expired, {
                now: Date.parse('2026-10-18T08:59:00.000Z'),
            }),
        ).toBe(server);
    });

    it('without a server answer, the browser’s own reading', () => {
        expect(preferredStateResolution(null, node({ status: 'paused' }), { now: NOW }).state).toBe(
            'paused',
        );
    });
});

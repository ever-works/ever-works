import {
    FLEET_VIRTUAL_HOST_REASONS,
    FLEET_VIRTUAL_WINDOWS_CAPABILITY,
    fleetVirtualSystem,
} from '@ever-works/contracts';
import {
    autoPickHost,
    capabilityValue,
    hostEligibility,
    hostReasonErrorCode,
    hostReasonHint,
    netFreeMemoryMiB,
    reservedMemoryMiB,
    type FleetVirtualHostFacts,
} from '../fleet-virtual.policy';
import { deriveVirtualState, fleetVirtualViewOf } from '../fleet-virtual.view';

/** Virtual computers (FL-16, T-06) — the host truth table, "Choose for me", reservations, view states. */

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const CUTOFF = NOW - 5 * 60_000;
const ubuntu = fleetVirtualSystem('ubuntu-26.04')!;
const arch = fleetVirtualSystem('arch')!;
const windows = fleetVirtualSystem('windows-11')!;

function host(patch: Partial<FleetVirtualHostFacts> = {}): FleetVirtualHostFacts {
    return {
        id: 'h1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        origin: 'enrolled',
        hostNodeId: null,
        capabilities: ['os:linux', 'arch:x64', 'docker', 'managed', 'virtual-host'],
        lastHeartbeatAt: new Date(NOW - 30_000),
        consents: { work: true, attend: false, manage: true, usageScan: false },
        health: { memTotalMiB: 32_768, memUsedMiB: 8_192, diskFreeMiB: 120_000 },
        ...patch,
    };
}

const judge = (facts: FleetVirtualHostFacts, system = ubuntu, childCount = 0, allowed = true) =>
    hostEligibility({ host: facts, system, childCount, offlineCutoffMs: CUTOFF, allowed });

describe('hostEligibility (spec FR-4, FR-5, FR-6, FR-9, FR-10)', () => {
    it('admits a Linux host with Docker, --manage and the FL-16 node', () => {
        expect(judge(host())).toBeNull();
        expect(
            judge(
                host({
                    capabilities: ['os:darwin', 'arch:arm64', 'docker', 'managed', 'virtual-host'],
                }),
            ),
        ).toBeNull();
    });

    it.each([
        ['is-virtual', host({ origin: 'virtual', hostNodeId: 'h0' })],
        ['desktop-node', host({ kind: 'desktop-node' })],
        [
            'windows-host',
            host({ capabilities: ['os:win32', 'arch:x64', 'docker', 'managed', 'virtual-host'] }),
        ],
        ['offline', host({ lastHeartbeatAt: new Date(NOW - 2 * 3_600_000) })],
        ['offline', host({ status: 'paused' })],
        [
            'consent-missing',
            host({
                consents: { work: true, attend: false, manage: false, usageScan: false },
                capabilities: ['os:linux', 'arch:x64', 'docker', 'virtual-host'],
            }),
        ],
        ['no-docker', host({ capabilities: ['os:linux', 'arch:x64', 'managed', 'virtual-host'] })],
        ['not-upgraded', host({ capabilities: ['os:linux', 'arch:x64', 'docker', 'managed'] })],
    ])('answers %s', (reason, facts) => {
        expect(judge(facts)).toBe(reason);
    });

    it('answers limit at four children, counting every state (CONTRACTS §10)', () => {
        expect(judge(host(), ubuntu, 3)).toBeNull();
        expect(judge(host(), ubuntu, 4)).toBe('limit');
    });

    it('answers permission-denied outside the machines audience, before the machine facts', () => {
        expect(judge(host({ status: 'offline' }), ubuntu, 0, false)).toBe('permission-denied');
    });

    it('offers Arch Linux on x86-64 only (FR-6)', () => {
        const arm = host({
            capabilities: ['os:linux', 'arch:arm64', 'docker', 'managed', 'virtual-host'],
        });
        expect(judge(arm, arch)).toBe('unsupported-arch');
        expect(judge(arm, ubuntu)).toBeNull();
    });

    it('offers Windows only on Linux x86-64 with kvm (FR-5, U3)', () => {
        expect(judge(host(), windows)).toBe('no-kvm');
        expect(
            judge(
                host({
                    capabilities: [
                        'os:linux',
                        'arch:x64',
                        'docker',
                        'managed',
                        'virtual-host',
                        'kvm',
                        FLEET_VIRTUAL_WINDOWS_CAPABILITY,
                    ],
                }),
                windows,
            ),
        ).toBeNull();
        // P2 (lane decision 14): kvm alone is not enough — the host's operator must
        // also have configured an installer image (`virtual-windows`).
        expect(
            judge(
                host({
                    capabilities: [
                        'os:linux',
                        'arch:x64',
                        'docker',
                        'managed',
                        'virtual-host',
                        'kvm',
                    ],
                }),
                windows,
            ),
        ).toBe('no-windows-image');
        expect(
            judge(
                host({
                    capabilities: [
                        'os:darwin',
                        'arch:x64',
                        'docker',
                        'managed',
                        'virtual-host',
                        'kvm',
                    ],
                }),
                windows,
            ),
        ).toBe('no-kvm');
    });

    it('gives every reason a CONTRACTS §8 code and a hint naming the host', () => {
        for (const reason of FLEET_VIRTUAL_HOST_REASONS) {
            expect(hostReasonErrorCode(reason)).toMatch(/^[a-z_]+$/);
            const hint = hostReasonHint(reason, { name: 'build-01' });
            expect(hint.length).toBeGreaterThan(0);
            if (reason !== 'desktop-node') expect(hint).toContain('build-01');
        }
        expect(hostReasonErrorCode('offline')).toBe('unreachable');
        expect(hostReasonErrorCode('consent-missing')).toBe('consent_missing');
        expect(hostReasonErrorCode('limit')).toBe('limit_exceeded');
        expect(hostReasonErrorCode('is-virtual')).toBe('unsupported_on_node');
        expect(hostReasonHint('consent-missing', { name: 'build-01' })).toBe(
            'Management is off — start the node with --manage on build-01',
        );
    });
});

describe('autoPickHost (S3)', () => {
    it('picks the eligible host with the most free memory, ties by name', () => {
        expect(
            autoPickHost([
                { nodeId: 'a', name: 'alpha', eligible: true, freeMemoryMiB: 4_000 },
                { nodeId: 'b', name: 'beta', eligible: true, freeMemoryMiB: 9_000 },
                { nodeId: 'c', name: 'gamma', eligible: false, freeMemoryMiB: 99_000 },
            ]),
        ).toBe('b');
        expect(
            autoPickHost([
                { nodeId: 'z', name: 'zulu', eligible: true, freeMemoryMiB: 8_000 },
                { nodeId: 'a', name: 'alpha', eligible: true, freeMemoryMiB: 8_000 },
            ]),
        ).toBe('a');
        expect(
            autoPickHost([{ nodeId: 'a', name: 'alpha', eligible: false, freeMemoryMiB: 1 }]),
        ).toBeNull();
    });
});

describe('reservations (S6)', () => {
    it('reserves every child and nets out only the ones not running', () => {
        const children = [
            { virtualMeta: { memoryGiB: 8, state: 'running' as const } },
            { virtualMeta: { memoryGiB: 4, state: 'stopped' as const } },
        ];
        expect(reservedMemoryMiB(children)).toBe(12 * 1024);
        expect(netFreeMemoryMiB({ memTotalMiB: 32_768, memUsedMiB: 8_192 }, children)).toBe(
            32_768 - 8_192 - 4_096,
        );
        expect(netFreeMemoryMiB(null, children)).toBeNull();
    });

    it('reads os and arch from the identity tags', () => {
        expect(capabilityValue(['os:linux', 'arch:arm64'], 'arch')).toBe('arm64');
        expect(capabilityValue([], 'os')).toBeNull();
    });
});

describe('the view state (FleetVirtualState)', () => {
    const meta = (patch: Record<string, unknown> = {}) => ({
        systemId: 'ubuntu-26.04',
        cpus: 2,
        memoryGiB: 4,
        diskGiB: null,
        phase: 'installing-runtime',
        phaseAt: null,
        state: 'creating',
        stateAt: null,
        error: null,
        activated: null,
        createJobId: 'j1',
        lastControlJobId: null,
        enrollRequestedAt: null,
        ...patch,
    });
    const child = (status: string, patch: Record<string, unknown> = {}) => ({
        origin: 'virtual',
        hostNodeId: 'h1',
        status,
        virtualMeta: meta(patch) as never,
    });

    it('follows the create phases while enrolling', () => {
        expect(deriveVirtualState(child('enrolling'), NOW)).toBe('creating');
        expect(deriveVirtualState(child('enrolling', { phase: 'enrolling' }), NOW)).toBe(
            'enrolling',
        );
        expect(deriveVirtualState(child('enrolling', { state: 'failed' }), NOW)).toBe('failed');
    });

    it('reads not-enrolled 20 minutes after the guest asked for its token (U10)', () => {
        const asked = new Date(NOW - 21 * 60_000).toISOString();
        expect(
            deriveVirtualState(
                child('enrolling', { phase: 'enrolling', enrollRequestedAt: asked }),
                NOW,
            ),
        ).toBe('not-enrolled');
    });

    it('is running while the child heartbeats, else the last machine state', () => {
        expect(deriveVirtualState(child('online', { state: 'running' }), NOW)).toBe('running');
        expect(deriveVirtualState(child('online', { state: 'stopping' }), NOW)).toBe('stopping');
        expect(deriveVirtualState(child('offline', { state: 'stopped' }), NOW)).toBe('stopped');
        expect(deriveVirtualState(child('offline', { state: 'gone' }), NOW)).toBe('gone');
        expect(deriveVirtualState(child('offline', { state: 'running' }), NOW)).toBe('stopped');
    });

    it('builds the view block only for a virtual computer, and never carries a failure that is not one', () => {
        expect(
            fleetVirtualViewOf({ origin: 'enrolled', status: 'online', virtualMeta: null }),
        ).toBeNull();
        const view = fleetVirtualViewOf(child('online', { error: 'old' }), 'build-01', NOW);
        expect(view).toMatchObject({
            state: 'running',
            systemLabel: 'Ubuntu 26.04',
            hostName: 'build-01',
            error: null,
        });
    });
});

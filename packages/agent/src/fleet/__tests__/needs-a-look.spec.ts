import {
    FLEET_CLEAR_MODEL_THROTTLE_COMMAND,
    FLEET_NODE_CLEAR_QUARANTINE_COMMAND,
    normalizeNeedsALookItem,
    type FleetNodeView,
    type NeedsALookItem,
} from '@ever-works/contracts';
import { NeedsALookService } from '../needs-a-look/needs-a-look.service';
import {
    CONSENT_MISSING_START_COMMAND,
    consentMissingItems,
} from '../needs-a-look/producers/consent-missing.producer';
import { diskLowItems } from '../needs-a-look/producers/disk-low.producer';
import { CHANGE_LIMITS_ROUTE } from '../needs-a-look/producers/health-producer.shared';
import { helperUntrustedItems } from '../needs-a-look/producers/helper-untrusted.producer';
import { FL03_NEEDS_A_LOOK_PRODUCERS } from '../needs-a-look/producers';
import { nodeQuarantinedItems } from '../needs-a-look/producers/node-quarantined.producer';
import { nodeThrottledItems } from '../needs-a-look/producers/node-throttled.producer';

const GIB = 1024 ** 3;
const NOW = new Date('2026-10-18T09:41:00.000Z');
const CONTEXT = { now: NOW };
/** A beat 48 s before NOW: well inside the default 5-minute offline window. */
const RECENT_BEAT = '2026-10-18T09:40:12.000Z';

function node(overrides: Partial<FleetNodeView> & Record<string, unknown> = {}): FleetNodeView {
    return {
        id: 'n1',
        name: 'design-mac',
        kind: 'node',
        status: 'online',
        platform: 'darwin/arm64',
        version: '0.3.0',
        capabilities: ['claude-code'],
        lastHeartbeatAt: RECENT_BEAT,
        createdAt: '2026-10-01T00:00:00.000Z',
        persisted: true,
        ...overrides,
    } as FleetNodeView;
}

/**
 * Computer health (FL-03) — the five "needs a look" producers. Each item is
 * exactly CONTRACTS §4.6 (FL-01's `NeedsALookItem`): plain-language `title`
 * and `detail`, at most one action that navigates or runs a named command,
 * a stable id and `since`. The registry, its ordering and its degradation
 * are FL-01's and tested there (`needs-a-look.service.spec.ts`).
 */
describe('FL-03 producers — each fires exactly in its condition (ACC-FL03-05)', () => {
    describe('disk-low (FR-12, spec S5)', () => {
        const low = node({
            diskFreeBytes: 6 * GIB,
            minFreeDiskBytes: 5 * GIB,
            health: {
                at: RECENT_BEAT,
                diskPercent: 94,
                diskTotalMiB: 100 * 1024,
                diskLowSince: '2026-10-18T07:00:00.000Z',
            },
        });

        it('is critical within 1 GiB of the node’s own floor, in the spec’s words', () => {
            expect(diskLowItems([low], CONTEXT)).toEqual([
                {
                    id: 'disk-low:n1',
                    nodeId: 'n1',
                    severity: 'critical',
                    kind: 'disk-low',
                    title: 'Disk is 94% full · 6 GiB left, the node stops at 5 GiB',
                    detail: 'Below its floor the node refuses new work. Free up space on the workspace volume.',
                    action: { label: 'Open', route: '/fleet/computers/n1?tab=overview' },
                    // Stable: the instant the platform first saw the disk low.
                    since: '2026-10-18T07:00:00.000Z',
                },
            ]);
        });

        it('is a warning below 10% free, and nothing above it', () => {
            const warn = node({
                diskFreeBytes: 9 * GIB,
                minFreeDiskBytes: 5 * GIB,
                health: { at: RECENT_BEAT, diskPercent: 91, diskTotalMiB: 100 * 1024 },
            });
            expect(diskLowItems([warn], CONTEXT)[0]).toMatchObject({
                severity: 'warn',
                title: 'Disk is 91% full · 9 GiB left',
                detail: 'Less than a tenth of the workspace volume is free.',
            });
            const fine = node({
                diskFreeBytes: 40 * GIB,
                minFreeDiskBytes: 5 * GIB,
                health: { at: RECENT_BEAT, diskTotalMiB: 100 * 1024 },
            });
            expect(diskLowItems([fine], CONTEXT)).toEqual([]);
        });

        it('with the floor switched off only the percentage rule applies — warn, never critical', () => {
            const noFloor = node({
                diskFreeBytes: 1 * GIB,
                minFreeDiskBytes: null,
                health: { at: RECENT_BEAT, diskTotalMiB: 100 * 1024 },
            });
            expect(diskLowItems([noFloor], CONTEXT)[0]?.severity).toBe('warn');
        });

        it('an older daemon (no snapshot) says only what is left, from the platform’s stable marker', () => {
            const older = node({
                diskFreeBytes: 6 * GIB,
                minFreeDiskBytes: 5 * GIB,
                // What the heartbeat stores for a daemon that reports no snapshot.
                health: { at: RECENT_BEAT, diskLowSince: '2026-10-18T06:30:00.000Z' },
            });
            expect(diskLowItems([older], CONTEXT)[0]).toMatchObject({
                severity: 'critical',
                title: '6 GiB left on the disk, the node stops at 5 GiB',
                since: '2026-10-18T06:30:00.000Z',
            });
        });

        it('skips offline computers — by status or by silence past the window — enrolling rows and cluster rows', () => {
            expect(diskLowItems([{ ...low, status: 'offline' }], CONTEXT)).toEqual([]);
            // Still `online` in the row, but silent for an hour: its figure is an hour old.
            expect(
                diskLowItems([{ ...low, lastHeartbeatAt: '2026-10-18T08:41:00.000Z' }], CONTEXT),
            ).toEqual([]);
            expect(diskLowItems([{ ...low, status: 'enrolling' }], CONTEXT)).toEqual([]);
            expect(diskLowItems([{ ...low, kind: 'k8s', persisted: false }], CONTEXT)).toEqual([]);
        });
    });

    describe('node-throttled (FR-13)', () => {
        const throttle = (provider: string, until: string) => ({
            provider,
            window: 'weekly' as const,
            until,
            reason: "You've hit your weekly limit",
            since: '2026-10-18T03:00:00.000Z',
        });

        it('limited: names the CLI and the reset, and runs the named clear command (spec S3)', () => {
            const limited = node({
                workerState: 'throttled',
                modelThrottles: [throttle('claude-code', '2026-10-19T01:00:00.000Z')],
            });
            expect(nodeThrottledItems([limited], CONTEXT)).toEqual([
                {
                    id: 'node-throttled:n1',
                    nodeId: 'n1',
                    severity: 'warn',
                    kind: 'node-throttled',
                    title: "Waiting for Claude Code's limit to reset at Mon 19 Oct 01:00 UTC",
                    detail: "You've hit your weekly limit",
                    action: {
                        label: 'Clear limit now',
                        command: FLEET_CLEAR_MODEL_THROTTLE_COMMAND,
                    },
                    since: '2026-10-18T03:00:00.000Z',
                },
            ]);
        });

        it('limited on two CLIs: plural, and still one item per computer', () => {
            const both = node({
                capabilities: ['claude-code', 'codex'],
                workerState: 'throttled',
                modelThrottles: [
                    throttle('codex', '2026-10-19T03:00:00.000Z'),
                    throttle('claude-code', '2026-10-19T01:00:00.000Z'),
                ],
            });
            const items = nodeThrottledItems([both], CONTEXT);
            expect(items).toHaveLength(1);
            expect(items[0].title).toBe(
                'Waiting for model limits to reset — the first, Claude Code, at Mon 19 Oct 01:00 UTC',
            );
            expect(items[0].action).toEqual({
                label: 'Clear limits now',
                command: FLEET_CLEAR_MODEL_THROTTLE_COMMAND,
            });
        });

        it('throttled: the dimension sentence of U13, with Change limits where limits are set', () => {
            const throttled = node({
                workerState: 'throttled',
                workerStateReason: 'host CPU 92% is at or above the 85% ceiling',
                workerStateChangedAt: '2026-10-18T09:30:00.000Z',
                health: { at: RECENT_BEAT, cpuPercent: 92.2 },
                effectiveLimits: { maxConcurrentJobs: 1, maxCpuPercent: 85, maxMemoryMb: null },
            });
            expect(nodeThrottledItems([throttled], CONTEXT)[0]).toMatchObject({
                title: 'Pausing new work — CPU is above its ceiling (92% of 85%)',
                detail: 'host CPU 92% is at or above the 85% ceiling',
                action: { label: 'Change limits', route: CHANGE_LIMITS_ROUTE },
                since: '2026-10-18T09:30:00.000Z',
            });
            expect(CHANGE_LIMITS_ROUTE).toBe('/settings/fleet');
        });

        it('a shared reader’s row (no reasons, no limits) still reads in words, without the owner’s sentence', () => {
            const shared = node({
                viewerRole: 'org-member',
                workerState: 'throttled',
                modelThrottles: [
                    { ...throttle('claude-code', '2026-10-19T01:00:00.000Z'), reason: '' },
                ],
            });
            expect(nodeThrottledItems([shared], CONTEXT)[0]).toMatchObject({
                title: "Waiting for Claude Code's limit to reset at Mon 19 Oct 01:00 UTC",
                detail: '',
            });
        });

        it('fires for nothing else: an online, busy, quarantined, offline or long-silent computer', () => {
            expect(
                nodeThrottledItems(
                    [
                        node(),
                        node({ workerState: 'working' }),
                        node({ workerState: 'quarantined' }),
                    ],
                    CONTEXT,
                ),
            ).toEqual([]);
            expect(
                nodeThrottledItems(
                    [
                        node({ status: 'offline', workerState: 'throttled' }),
                        node({
                            workerState: 'throttled',
                            lastHeartbeatAt: '2026-10-18T08:00:00.000Z',
                        }),
                    ],
                    CONTEXT,
                ),
            ).toEqual([]);
        });
    });

    describe('node-quarantined (FR-14, spec S4)', () => {
        it('is critical, carries the node’s reason, and gives the exact command in words — never a button that pretends to clear it', () => {
            const quarantined = node({
                workerState: 'quarantined',
                workerStateReason: 'process tree unproven',
                workerStateChangedAt: '2026-10-18T03:14:00.000Z',
            });
            expect(nodeQuarantinedItems([quarantined], CONTEXT)).toEqual([
                {
                    id: 'node-quarantined:n1',
                    nodeId: 'n1',
                    severity: 'critical',
                    kind: 'node-quarantined',
                    title: 'design-mac stopped itself: process tree unproven',
                    detail: `On design-mac, after checking that no earlier job is still running there, run: ${FLEET_NODE_CLEAR_QUARANTINE_COMMAND}`,
                    action: { label: 'Show command', route: '/fleet/computers/n1?tab=overview' },
                    since: '2026-10-18T03:14:00.000Z',
                },
            ]);
        });

        it('without the node’s reason (a shared reader) says only that it stopped itself', () => {
            const shared = node({ workerState: 'quarantined', viewerRole: 'org-member' });
            expect(nodeQuarantinedItems([shared], CONTEXT)[0].title).toBe(
                'design-mac stopped itself',
            );
        });

        it('fires only for a quarantined, reachable computer', () => {
            expect(
                nodeQuarantinedItems([node(), node({ workerState: 'throttled' })], CONTEXT),
            ).toEqual([]);
            expect(
                nodeQuarantinedItems(
                    [
                        node({ status: 'offline', workerState: 'quarantined' }),
                        node({
                            workerState: 'quarantined',
                            lastHeartbeatAt: '2026-10-18T08:00:00.000Z',
                        }),
                    ],
                    CONTEXT,
                ),
            ).toEqual([]);
        });
    });

    describe('consent-missing (FR-15, spec S10)', () => {
        it('is info, naming the start command, when every consent is reported off', () => {
            const enrolOnly = node({
                name: 'win-lab',
                consents: { work: false, attend: false, manage: false, usageScan: false },
            });
            expect(consentMissingItems([enrolOnly], CONTEXT)).toEqual([
                {
                    id: 'consent-missing:n1',
                    nodeId: 'n1',
                    severity: 'info',
                    kind: 'consent-missing',
                    title: 'win-lab only reports health. Start it with --work, --attend or --manage to do more.',
                    detail: `For example, on win-lab run: ${CONSENT_MISSING_START_COMMAND}`,
                    action: { label: 'Show command', route: '/fleet/computers/n1?tab=overview' },
                    since: '2026-10-01T00:00:00.000Z',
                },
            ]);
        });

        it('is silent with any consent on, and while consents are not reported at all (never inferred)', () => {
            expect(
                consentMissingItems(
                    [
                        node({
                            consents: {
                                work: true,
                                attend: false,
                                manage: false,
                                usageScan: false,
                            },
                        }),
                    ],
                    CONTEXT,
                ),
            ).toEqual([]);
            expect(
                consentMissingItems(
                    [
                        node({
                            consents: {
                                work: false,
                                attend: false,
                                manage: true,
                                usageScan: false,
                            },
                        }),
                    ],
                    CONTEXT,
                ),
            ).toEqual([]);
            expect(consentMissingItems([node()], CONTEXT)).toEqual([]);
            // A malformed row (not FL-02's normalized four) is silent, never "all off".
            expect(
                consentMissingItems([node({ consents: { work: false } as never })], CONTEXT),
            ).toEqual([]);
            // A daemon older than the field: null on the view.
            expect(consentMissingItems([node({ consents: null })], CONTEXT)).toEqual([]);
        });
    });

    describe('helper-untrusted (FR-16)', () => {
        it('is a warning for a hash-pinned helper', () => {
            expect(
                helperUntrustedItems([node({ helperTrust: 'hash-pinned' })], CONTEXT)[0],
            ).toMatchObject({
                id: 'helper-untrusted:n1',
                severity: 'warn',
                title: "design-mac's screen helper runs with reduced trust",
                action: { label: 'Open', route: '/fleet/computers/n1?tab=overview' },
            });
        });

        it('produces NOTHING while the field is absent — every row until FL-07 reports it — or not hash-pinned', () => {
            expect(helperUntrustedItems([node()], CONTEXT)).toEqual([]);
            expect(
                helperUntrustedItems(
                    [node({ helperTrust: 'signed' }), node({ helperTrust: 'none' })],
                    CONTEXT,
                ),
            ).toEqual([]);
        });
    });

    it('every producer gives the same id and since on a second render of the same condition (FR-17)', () => {
        const nodes = [
            node({
                id: 'a',
                diskFreeBytes: 6 * GIB,
                minFreeDiskBytes: 5 * GIB,
                health: { at: RECENT_BEAT, diskLowSince: '2026-10-18T06:30:00.000Z' },
            }),
            node({
                id: 'b',
                workerState: 'quarantined',
                workerStateChangedAt: '2026-10-18T03:14:00.000Z',
            }),
        ];
        const later = { now: new Date(NOW.getTime() + 60_000) };
        const render = (context: { now: Date }) =>
            [...diskLowItems(nodes, context), ...nodeQuarantinedItems(nodes, context)].map(
                (entry) => [entry.id, entry.since],
            );
        expect(render(later)).toEqual(render(CONTEXT));
        expect(render(CONTEXT)).toHaveLength(2);
    });
});

/**
 * Through FL-01's REAL registry: the module's producer list registers, and
 * every item each producer raises survives `normalizeNeedsALookItem`
 * unchanged — a field out of bounds, a route the guard refuses or a command
 * outside the pattern would be silently dropped or clipped there.
 */
describe('FL-03 producers in FL-01’s registry (CONTRACTS §4.6 conformance)', () => {
    const everyCondition: FleetNodeView[] = [
        node({
            id: 'disk',
            diskFreeBytes: 6 * GIB,
            minFreeDiskBytes: 5 * GIB,
            health: { at: RECENT_BEAT, diskPercent: 94, diskTotalMiB: 102400 },
        }),
        node({
            id: 'limited',
            workerState: 'throttled',
            modelThrottles: [
                {
                    provider: 'claude-code',
                    window: 'weekly',
                    until: '2026-10-19T01:00:00.000Z',
                    reason: 'weekly limit',
                    since: '2026-10-18T03:00:00.000Z',
                },
            ],
        }),
        node({
            id: 'cpu',
            workerState: 'throttled',
            health: { at: RECENT_BEAT, cpuPercent: 92 },
            effectiveLimits: { maxConcurrentJobs: 1, maxCpuPercent: 85, maxMemoryMb: null },
        }),
        node({ id: 'quarantined', workerState: 'quarantined', workerStateReason: 'unproven' }),
        node({
            id: 'enrol-only',
            consents: { work: false, attend: false, manage: false, usageScan: false },
        }),
        node({ id: 'helper', helperTrust: 'hash-pinned' }),
    ];

    it('registers all five, in order, under fl-03 ids', () => {
        const registry = new NeedsALookService(FL03_NEEDS_A_LOOK_PRODUCERS.map((P) => new P()));
        expect(registry.registered()).toEqual([
            'fl-03.disk-low',
            'fl-03.node-throttled',
            'fl-03.node-quarantined',
            'fl-03.consent-missing',
            'fl-03.helper-untrusted',
        ]);
    });

    it('every item survives the registry’s normaliser unchanged, and the read is complete', async () => {
        const producers = FL03_NEEDS_A_LOOK_PRODUCERS.map((P) => new P());
        const raised: NeedsALookItem[] = [];
        for (const producer of producers) {
            raised.push(...(await producer.produce(everyCondition, { userId: 'u1', now: NOW })));
        }
        expect(raised.map((item) => item.kind).sort()).toEqual([
            'consent-missing',
            'disk-low',
            'helper-untrusted',
            'node-quarantined',
            'node-throttled',
            'node-throttled',
        ]);
        for (const item of raised) expect(normalizeNeedsALookItem(item)).toEqual(item);

        const answer = await new NeedsALookService(producers).forNodes(everyCondition, {
            userId: 'u1',
            now: NOW,
        });
        expect(answer.partial).toBe(false);
        expect(answer.items).toHaveLength(raised.length);
        // Critical first (FR-5): the disk at its floor and the quarantine lead.
        expect(answer.items.slice(0, 2).map((item) => item.severity)).toEqual([
            'critical',
            'critical',
        ]);
    });
});

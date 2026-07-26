import type { KbMemoryConsolidationSettings } from '@ever-works/contracts';
import {
    isDue,
    MemoryConsolidationScheduleService,
    resolveCadence,
    resolveMode,
} from '../memory-consolidation-schedule.service';
import type { MemoryConsolidationReport } from '../memory-consolidation.service';

/**
 * Consolidation cadence (M9).
 *
 * The invariants under test are the promises the feature makes to an
 * operator who turns it on: it only touches orgs that opted in, it
 * writes nothing by default, and even when it does write, what lands is
 * `proposed` (review-gated), never applied truth.
 */

const ORG_ID = 'org-1';
const TENANT_ID = 'tenant-1';
const OWNER_ID = 'user-1';
const NOW = new Date('2026-07-26T12:00:00Z');

function daysAgo(days: number): string {
    return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function report(overrides: Partial<MemoryConsolidationReport> = {}): MemoryConsolidationReport {
    return {
        scanned: 40,
        promoted: 3,
        synthesized: 1,
        superseded: 2,
        dryRun: true,
        notes: [],
        details: { promotedIds: [], supersededPairs: [], synthesizedIds: [] },
        ...overrides,
    };
}

interface Harness {
    service: MemoryConsolidationScheduleService;
    runConsolidation: jest.Mock;
    notify: jest.Mock;
    update: jest.Mock;
    tryGetOrgHealth: jest.Mock;
}

function buildHarness(
    orgs: Array<{
        id: string;
        tenantId: string;
        memoryConsolidation: KbMemoryConsolidationSettings | null;
    }>,
    options: { ownerUserId?: string | null; healthGaps?: unknown } = {},
): Harness {
    const update = jest.fn().mockResolvedValue(undefined);
    const organizationRepository = {
        findWithMemoryConsolidationSettings: jest.fn().mockResolvedValue(orgs),
        findById: jest.fn().mockResolvedValue(orgs[0] ?? null),
        update,
    };
    const tenantRepository = {
        findById: jest
            .fn()
            .mockResolvedValue(
                options.ownerUserId === null
                    ? null
                    : { id: TENANT_ID, ownerUserId: options.ownerUserId ?? OWNER_ID },
            ),
    };
    const runConsolidation = jest.fn().mockResolvedValue(report());
    const tryGetOrgHealth = jest.fn().mockResolvedValue(
        options.healthGaps ?? {
            gapTopics: [
                { query: 'how do we deploy', occurrences: 3, lastSeenAt: NOW.toISOString() },
            ],
            uncitedDocs: [{ documentId: 'd1', title: 'Stale runbook', retrievals: 5 }],
        },
    );
    const notify = jest.fn().mockResolvedValue(undefined);

    const service = new MemoryConsolidationScheduleService(
        organizationRepository as never,
        tenantRepository as never,
        { runConsolidation } as never,
        { tryGetOrgHealth } as never,
        { notifyMemoryConsolidation: notify } as never,
    );

    return { service, runConsolidation, notify, update, tryGetOrgHealth };
}

describe('MemoryConsolidationScheduleService — opt-in gating', () => {
    it('skips an organization that never enabled the cadence', async () => {
        const { service, runConsolidation } = buildHarness([
            { id: ORG_ID, tenantId: TENANT_ID, memoryConsolidation: { cadence: 'daily' } },
        ]);

        const summary = await service.dispatchDue({ now: NOW });

        expect(runConsolidation).not.toHaveBeenCalled();
        expect(summary.ran).toBe(0);
        expect(summary.skipped.disabled).toBe(1);
    });

    it('skips an organization whose settings are null (every org today)', async () => {
        const { service, runConsolidation } = buildHarness([
            { id: ORG_ID, tenantId: TENANT_ID, memoryConsolidation: null },
        ]);

        const summary = await service.dispatchDue({ now: NOW });

        expect(runConsolidation).not.toHaveBeenCalled();
        expect(summary.skipped.disabled).toBe(1);
    });

    it('runs an enabled organization whose cadence has elapsed', async () => {
        const { service, runConsolidation } = buildHarness([
            {
                id: ORG_ID,
                tenantId: TENANT_ID,
                memoryConsolidation: { enabled: true, cadence: 'weekly', lastRunAt: daysAgo(8) },
            },
        ]);

        const summary = await service.dispatchDue({ now: NOW });

        expect(runConsolidation).toHaveBeenCalledTimes(1);
        expect(summary.ran).toBe(1);
    });

    it('respects the per-org cadence even though the cron fires daily', async () => {
        const { service, runConsolidation } = buildHarness([
            {
                id: ORG_ID,
                tenantId: TENANT_ID,
                memoryConsolidation: { enabled: true, cadence: 'weekly', lastRunAt: daysAgo(2) },
            },
        ]);

        const summary = await service.dispatchDue({ now: NOW });

        expect(runConsolidation).not.toHaveBeenCalled();
        expect(summary.skipped['not-due']).toBe(1);
    });

    it('skips (rather than crashes) when no owner user can be resolved for the org', async () => {
        const { service, runConsolidation } = buildHarness(
            [{ id: ORG_ID, tenantId: TENANT_ID, memoryConsolidation: { enabled: true } }],
            { ownerUserId: null },
        );

        const summary = await service.dispatchDue({ now: NOW });

        expect(runConsolidation).not.toHaveBeenCalled();
        expect(summary.skipped['no-owner']).toBe(1);
    });

    it('counts a failing organization and keeps sweeping the rest', async () => {
        const { service, runConsolidation } = buildHarness([
            { id: 'org-a', tenantId: TENANT_ID, memoryConsolidation: { enabled: true } },
            { id: 'org-b', tenantId: TENANT_ID, memoryConsolidation: { enabled: true } },
        ]);
        // First org throws, second must still run.
        runConsolidation.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(report());

        const summary = await service.dispatchDue({ now: NOW });

        expect(summary.skipped.failed).toBe(1);
        expect(summary.ran).toBe(1);
    });
});

describe('MemoryConsolidationScheduleService — dry-run by default', () => {
    it('runs with apply:false when the org did not choose a mode', async () => {
        const { service, runConsolidation } = buildHarness([
            { id: ORG_ID, tenantId: TENANT_ID, memoryConsolidation: { enabled: true } },
        ]);

        const summary = await service.dispatchDue({ now: NOW });

        expect(runConsolidation).toHaveBeenCalledWith(
            { organizationId: ORG_ID, userId: OWNER_ID },
            expect.objectContaining({ apply: false }),
        );
        expect(summary.dryRun).toBe(1);
        expect(summary.proposed).toBe(0);
    });

    it('runs with apply:true only when the org explicitly opted into propose mode', async () => {
        const { service, runConsolidation } = buildHarness([
            {
                id: ORG_ID,
                tenantId: TENANT_ID,
                memoryConsolidation: { enabled: true, mode: 'propose' },
            },
        ]);

        const summary = await service.dispatchDue({ now: NOW });

        expect(runConsolidation).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ apply: true }),
        );
        expect(summary.proposed).toBe(1);
    });

    it('treats an unknown mode string as dry-run rather than trusting it', async () => {
        const { service, runConsolidation } = buildHarness([
            {
                id: ORG_ID,
                tenantId: TENANT_ID,
                memoryConsolidation: {
                    enabled: true,
                    mode: 'apply-everything' as never,
                },
            },
        ]);

        await service.dispatchDue({ now: NOW });

        expect(runConsolidation).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ apply: false }),
        );
    });
});

describe('MemoryConsolidationScheduleService — notification + bookkeeping', () => {
    it('notifies the owner with the report line and links to Memory', async () => {
        const { service, notify } = buildHarness([
            {
                id: ORG_ID,
                tenantId: TENANT_ID,
                memoryConsolidation: { enabled: true, mode: 'propose' },
            },
        ]);

        const summary = await service.dispatchDue({ now: NOW });

        expect(summary.notified).toBe(1);
        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: OWNER_ID,
                organizationId: ORG_ID,
                mode: 'propose',
                message: expect.stringContaining('3 promoted / 1 synthesized / 2 superseded'),
            }),
        );
        // Propose mode routes the reader to the review queue, not to Apply.
        expect(notify.mock.calls[0][0].message).toContain('review queue');
    });

    it('stays silent when the pass found nothing — a "0 / 0 / 0" ping is noise', async () => {
        const { service, notify, runConsolidation } = buildHarness([
            { id: ORG_ID, tenantId: TENANT_ID, memoryConsolidation: { enabled: true } },
        ]);
        runConsolidation.mockResolvedValue(report({ promoted: 0, synthesized: 0, superseded: 0 }));

        const summary = await service.dispatchDue({ now: NOW });

        expect(summary.ran).toBe(1);
        expect(notify).not.toHaveBeenCalled();
    });

    it('respects an explicit notify:false opt-out', async () => {
        const { service, notify } = buildHarness([
            {
                id: ORG_ID,
                tenantId: TENANT_ID,
                memoryConsolidation: { enabled: true, notify: false },
            },
        ]);

        await service.dispatchDue({ now: NOW });

        expect(notify).not.toHaveBeenCalled();
    });

    it('stamps lastRunAt so the next tick honours the cadence', async () => {
        const { service, update } = buildHarness([
            {
                id: ORG_ID,
                tenantId: TENANT_ID,
                memoryConsolidation: { enabled: true, cadence: 'daily' },
            },
        ]);

        await service.dispatchDue({ now: NOW });

        expect(update).toHaveBeenCalledWith(ORG_ID, {
            memoryConsolidation: expect.objectContaining({
                enabled: true,
                cadence: 'daily',
                lastRunAt: NOW.toISOString(),
            }),
        });
    });

    it('still reports the pass as run when the notification transport fails', async () => {
        const { service, notify } = buildHarness([
            { id: ORG_ID, tenantId: TENANT_ID, memoryConsolidation: { enabled: true } },
        ]);
        notify.mockRejectedValue(new Error('smtp down'));

        const summary = await service.dispatchDue({ now: NOW });

        expect(summary.ran).toBe(1);
        expect(summary.notified).toBe(0);
    });
});

describe('MemoryConsolidationScheduleService — gap-fed synthesis (M11)', () => {
    it('carries the measured retrieval gaps into the consolidation run', async () => {
        const { service, runConsolidation } = buildHarness([
            { id: ORG_ID, tenantId: TENANT_ID, memoryConsolidation: { enabled: true } },
        ]);

        await service.dispatchDue({ now: NOW });

        expect(runConsolidation).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                gaps: {
                    unansweredQueries: [{ query: 'how do we deploy', occurrences: 3 }],
                    uncitedTitles: ['Stale runbook'],
                },
            }),
        );
    });

    it('runs with no gaps when health is unavailable — telemetry never fails a pass', async () => {
        const { service, runConsolidation, tryGetOrgHealth } = buildHarness([
            { id: ORG_ID, tenantId: TENANT_ID, memoryConsolidation: { enabled: true } },
        ]);
        tryGetOrgHealth.mockResolvedValue(null);

        await service.dispatchDue({ now: NOW });

        expect(runConsolidation).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ gaps: null }),
        );
    });
});

describe('cadence helpers', () => {
    it('defaults an absent or unknown cadence to weekly', () => {
        expect(resolveCadence(null)).toBe('weekly');
        expect(resolveCadence({ cadence: 'hourly' as never })).toBe('weekly');
        expect(resolveCadence({ cadence: 'daily' })).toBe('daily');
    });

    it('defaults an absent mode to dry-run', () => {
        expect(resolveMode(null)).toBe('dry-run');
        expect(resolveMode({ mode: 'propose' })).toBe('propose');
    });

    it('treats "never ran" and an unparseable stamp as due', () => {
        expect(isDue({ enabled: true }, NOW)).toBe(true);
        expect(isDue({ enabled: true, lastRunAt: 'not-a-date' }, NOW)).toBe(true);
    });

    it('treats a FUTURE lastRunAt as not due — the conservative direction under clock skew', () => {
        const future = new Date(NOW.getTime() + 86_400_000).toISOString();
        expect(isDue({ enabled: true, lastRunAt: future }, NOW)).toBe(false);
    });

    it('honours each cadence interval exactly', () => {
        expect(isDue({ cadence: 'daily', lastRunAt: daysAgo(1) }, NOW)).toBe(true);
        expect(isDue({ cadence: 'weekly', lastRunAt: daysAgo(6) }, NOW)).toBe(false);
        expect(isDue({ cadence: 'monthly', lastRunAt: daysAgo(30) }, NOW)).toBe(true);
    });
});

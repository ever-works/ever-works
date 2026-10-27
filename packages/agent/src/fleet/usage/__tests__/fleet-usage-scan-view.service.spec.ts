import { ForbiddenException } from '@nestjs/common';
import { FLEET_USAGE_PAYER_NOTE } from '@ever-works/contracts';
import { FleetUsageScanService } from '../fleet-usage-scan.service';
import { FleetUsageViewService } from '../fleet-usage-view.service';
import { FleetUsageException } from '../fleet-usage.errors';
import { PublishedModelListPrices } from '../../../usage/model-list-prices';

/**
 * FL-20 T-14, T-15, T-24 — the dispatcher (only opted-in, tagged, online
 * computers; never a second scan while one waits), the owner's rescan with
 * every CONTRACTS §8 code and hint (FR-18), and the one Usage object: periods,
 * opt-in hint, offline computers kept, unknown models excluded from dollars,
 * "other" sessions the machine owner's alone (spec §8b), the payer note.
 */

const OWNER = 'owner-1';
const NODE_ON = '11111111-1111-4111-8111-111111111111';
const NODE_OFF = '22222222-2222-4222-8222-222222222222';
const NODE_OLD = '33333333-3333-4333-8333-333333333333';
const NODE_SHARED = '44444444-4444-4444-8444-444444444444';

function node(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        userId: OWNER,
        organizationId: null,
        name: `pc-${id.slice(0, 4)}`,
        status: 'online',
        capabilities: ['usage-scan'],
        consents: { work: true, attend: false, manage: false, usageScan: true },
        lastHeartbeatAt: new Date(),
        ...overrides,
    };
}

const NODES: Record<string, ReturnType<typeof node>> = {
    [NODE_ON]: node(NODE_ON, { name: 'build-01' }),
    [NODE_OFF]: node(NODE_OFF, {
        name: 'laptop',
        capabilities: [],
        consents: { work: true, attend: false, manage: false, usageScan: false },
    }),
    [NODE_OLD]: node(NODE_OLD, { name: 'old-box', capabilities: [], consents: null }),
    [NODE_SHARED]: node(NODE_SHARED, { name: 'team-box', userId: 'someone-else' }),
};

function access() {
    return {
        resolveVisible: jest.fn(async (id: string, caller: string) => {
            const found = NODES[id];
            if (!found) throw Object.assign(new Error('not found'), { getStatus: () => 404 });
            return { node: found, role: found.userId === caller ? 'owner' : 'org-member' };
        }),
        listSharedWith: jest.fn(async () => [{ node: NODES[NODE_SHARED], role: 'org-member' }]),
    };
}

function scanHarness(
    options: { stopped?: boolean; waiting?: { id: string } | null; acked?: number | null } = {},
) {
    const candidates = Object.values(NODES).concat([
        node('55555555-5555-4555-8555-555555555555', { name: 'offline', status: 'offline' }),
    ]);
    const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn(async () =>
            candidates.filter((candidate) => candidate.status === 'online'),
        ),
    };
    const nodeRows = { createQueryBuilder: jest.fn(() => qb) };
    const jobRows = {
        find: jest.fn(
            async (query: {
                where: Record<string, unknown>;
            }): Promise<Array<Record<string, unknown>>> => {
                if (query.where.status === 'done') {
                    return options.acked === undefined
                        ? []
                        : [
                              {
                                  id: 'done-1',
                                  result: {
                                      watermark: options.acked,
                                      ingestedAt: '2026-10-21T00:00:00.000Z',
                                  },
                              },
                          ];
                }
                // Active scans: build-01 has none; team-box has one queued.
                return [{ id: 'busy-job', targetNodeId: NODE_SHARED }];
            },
        ),
        findOne: jest.fn(async () => options.waiting ?? null),
    };
    const jobs = {
        enqueue: jest.fn(async (input: Record<string, unknown>) => ({ id: 'job-new', ...input })),
    };
    const killSwitch = { isStopped: jest.fn(async () => options.stopped === true) };
    const service = new FleetUsageScanService(
        nodeRows as never,
        jobRows as never,
        jobs as never,
        access() as never,
        killSwitch as never,
    );
    return { service, jobs, jobRows };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; hint: string }> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof FleetUsageException)
            return { code: error.code, hint: error.usageError.hint };
        throw error;
    }
    throw new Error('expected a refusal');
}

describe('FleetUsageScanService', () => {
    const previous = process.env.FLEET_USAGE_SCAN_ENABLED;
    beforeEach(() => {
        process.env.FLEET_USAGE_SCAN_ENABLED = 'true';
    });
    afterAll(() => {
        if (previous === undefined) delete process.env.FLEET_USAGE_SCAN_ENABLED;
        else process.env.FLEET_USAGE_SCAN_ENABLED = previous;
    });

    it('enqueues one pinned scan per opted-in, tagged, online computer — none for a busy one', async () => {
        const h = scanHarness();
        const now = new Date('2026-10-21T12:07:00.000Z');
        const result = await h.service.dispatchDue(now);
        // build-01 qualifies; laptop (no consent, no tag) and old-box do not; team-box has a scan waiting.
        expect(result).toEqual({ nodes: 2, enqueued: 1 });
        expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
        const input = h.jobs.enqueue.mock.calls[0][0] as Record<string, unknown>;
        expect(input).toMatchObject({
            kind: 'usage-scan',
            payload: { nodeId: NODE_ON, since: null },
            requiredCapabilities: ['usage-scan'],
            idempotencyKey: `usage-scan:${NODE_ON}:${Math.floor(now.getTime() / (15 * 60 * 1000))}`,
        });
    });

    it('hands the newest acknowledged watermark back as since', async () => {
        const h = scanHarness({ acked: 42 });
        await h.service.dispatchDue();
        const payloads = h.jobs.enqueue.mock.calls.map(
            (call) => (call[0] as { payload: unknown }).payload,
        );
        expect(payloads).toContainEqual({ nodeId: NODE_ON, since: 42 });
    });

    it('does nothing with the flag off or the kill switch on (U9)', async () => {
        process.env.FLEET_USAGE_SCAN_ENABLED = 'false';
        expect(await scanHarness().service.dispatchDue()).toEqual({ nodes: 0, enqueued: 0 });
        process.env.FLEET_USAGE_SCAN_ENABLED = 'true';
        expect(await scanHarness({ stopped: true }).service.dispatchDue()).toEqual({
            nodes: 0,
            enqueued: 0,
        });
    });

    it('answers every rescan refusal with its code and hint (FR-18)', async () => {
        const h = scanHarness();
        await expect(h.service.rescan(NODE_SHARED, OWNER)).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        expect(await refusal(h.service.rescan(NODE_OFF, OWNER))).toEqual({
            code: 'consent_missing',
            hint: 'Usage scan is off — run `ever-works-node start --usage-scan` on laptop',
        });
        expect(await refusal(h.service.rescan(NODE_OLD, OWNER))).toMatchObject({
            code: 'unsupported_on_node',
        });
        expect(
            await refusal(scanHarness({ stopped: true }).service.rescan(NODE_ON, OWNER)),
        ).toMatchObject({
            code: 'kill_switch',
        });
        NODES[NODE_ON].status = 'offline';
        try {
            expect(await refusal(h.service.rescan(NODE_ON, OWNER))).toMatchObject({
                code: 'unreachable',
            });
        } finally {
            NODES[NODE_ON].status = 'online';
        }
    });

    it('returns a waiting scan rather than doubling it, else enqueues one now', async () => {
        expect(
            await scanHarness({ waiting: { id: 'waiting-1' } }).service.rescan(NODE_ON, OWNER),
        ).toEqual({
            jobId: 'waiting-1',
        });
        const h = scanHarness();
        expect(await h.service.rescan(NODE_ON, OWNER)).toEqual({ jobId: 'job-new' });
    });
});

describe('FleetUsageViewService', () => {
    function viewHarness(rows: Array<Record<string, unknown>>) {
        const qb: Record<string, jest.Mock> = {};
        for (const name of ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'addGroupBy']) {
            qb[name] = jest.fn(() => qb);
        }
        qb.getRawMany = jest.fn(async () => rows);
        const samples = { createQueryBuilder: jest.fn(() => qb) };
        const sessions = {
            find: jest.fn(async () => [{ id: 'session-agent', kind: 'agent', agentId: 'agent-1' }]),
        };
        const runs = { find: jest.fn(async () => []) };
        const agents = { find: jest.fn(async () => [{ id: 'agent-1', name: 'Nina' }]) };
        const checkouts = { find: jest.fn(async () => []) };
        const nodes = {
            findByUser: jest.fn(async () => [NODES[NODE_ON], NODES[NODE_OFF], NODES[NODE_OLD]]),
        };
        const scans = {
            factsFor: jest.fn(
                async () =>
                    new Map([
                        [
                            NODE_ON,
                            { lastScanAt: new Date('2026-10-21T11:56:00.000Z'), backlogPct: 58 },
                        ],
                    ]),
            ),
        };
        return new FleetUsageViewService(
            samples as never,
            sessions as never,
            runs as never,
            agents as never,
            checkouts as never,
            nodes as never,
            access() as never,
            scans as never,
            new PublishedModelListPrices(),
        );
    }

    const sample = (overrides: Record<string, unknown>) => ({
        nodeId: NODE_ON,
        model: 'claude-sonnet-4-5',
        provider: 'claude-code',
        priceListVersion: 1,
        fleetSessionId: null,
        agentRunId: null,
        checkoutPath: '/home/owner/code/api',
        providerSessionId: 's',
        inputTokens: '1000000',
        outputTokens: '0',
        cacheReadTokens: '0',
        cacheWriteTokens: '0',
        requests: '10',
        ...overrides,
    });

    it('refuses a period that is not 1, 7, 30 or 90 with `invalid`', async () => {
        expect(await refusal(viewHarness([]).view(OWNER, { days: 14 }))).toMatchObject({
            code: 'invalid',
        });
    });

    it('answers consent_missing / unsupported_on_node for one computer (U1, U3)', async () => {
        expect(await refusal(viewHarness([]).view(OWNER, { nodeId: NODE_OFF }))).toEqual({
            code: 'consent_missing',
            hint: 'Usage scan is off — run `ever-works-node start --usage-scan` on laptop',
        });
        expect(await refusal(viewHarness([]).view(OWNER, { nodeId: NODE_OLD }))).toMatchObject({
            code: 'unsupported_on_node',
        });
    });

    it('builds the tab object: totals over priced models, unknown models excluded, every computer kept, the payer note', async () => {
        const view = await viewHarness([
            sample({ fleetSessionId: 'session-agent' }),
            sample({ model: 'local-7b', priceListVersion: null, requests: '12' }),
            sample({ nodeId: NODE_SHARED, providerSessionId: 'theirs' }),
        ]).view(OWNER, { days: 30 }, new Date('2026-10-21T12:00:00.000Z'));
        expect(view.days).toBe(30);
        expect(view.note).toBe(FLEET_USAGE_PAYER_NOTE);
        // 1 M input tokens of claude-sonnet-4-5 at $3 / M on build-01 (the shared computer's "other" row is hidden).
        expect(view.totals.costCents).toBe(300);
        expect(view.unknownModels).toEqual({ models: ['local-7b'], requests: 12 });
        expect(view.byNode.map((line) => [line.name, line.scan.state])).toEqual(
            expect.arrayContaining([
                ['build-01', 'on'],
                ['laptop', 'off'],
                ['old-box', 'unsupported'],
                ['team-box', 'on'],
            ]),
        );
        expect(view.byNode.find((line) => line.name === 'laptop')?.scan.hint).toContain(
            '--usage-scan',
        );
        expect(view.excluded.otherHidden).toBe(true);
        expect(view.sessions.agents).toEqual([
            { agentId: 'agent-1', name: 'Nina', sessions: 1, costCents: 300 },
        ]);
        expect(view.sessions.other).toEqual({ sessions: 1, costCents: null });
        expect(view.catchingUp).toEqual({ nodeId: NODE_ON, nodeName: 'build-01', scannedPct: 42 });
    });
});

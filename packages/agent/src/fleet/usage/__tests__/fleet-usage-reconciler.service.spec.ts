import { FindOperator } from 'typeorm';
import type { FleetUsageReport, FleetUsageRow } from '@ever-works/contracts';
import { FleetUsageReconcilerService } from '../fleet-usage-reconciler.service';
import { PublishedModelListPrices } from '../../../usage/model-list-prices';

/**
 * FL-20 T-12, T-13, T-23 — the report → samples → Session → Run → ledger
 * chain: attribution by provider session id (then a Task run's CLI session),
 * the field-wise maximum (never double counts, never subtracts), the late
 * claim of "other" rows, the Run roll-up, and ONE ledger total per Run (a
 * headless run's own CLI-reported row is topped up, never counted twice; no
 * credit is ever debited — only `record` with the `fleet-node:` plugin id).
 */

const NODE = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const TASK_RUN = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';

type Row = Record<string, unknown> & { id: string };

function matches(row: Row, where: Record<string, unknown>): boolean {
    for (const [key, expected] of Object.entries(where)) {
        const actual = row[key];
        if (expected instanceof FindOperator) {
            const type = (expected as unknown as { type: string }).type;
            const value = (expected as unknown as { value: unknown }).value;
            if (type === 'in' && !(value as unknown[]).includes(actual)) return false;
            if (type === 'isNull' && actual !== null && actual !== undefined) return false;
            continue;
        }
        if (actual !== expected) return false;
    }
    return true;
}

/** The slice of TypeORM's Repository the services use, over an array. */
class FakeRepo {
    rows: Row[] = [];
    private seq = 0;
    constructor(private readonly prefix: string) {}
    create = (input: Record<string, unknown>) => ({ ...input }) as Row;
    save = async (input: Row) => {
        if (!input.id) input.id = `${this.prefix}-${++this.seq}`;
        if (!input.createdAt) input.createdAt = new Date();
        const at = this.rows.findIndex((row) => row.id === input.id);
        if (at >= 0) this.rows[at] = { ...this.rows[at], ...input };
        else this.rows.push({ ...input });
        return input;
    };
    find = async (options: { where?: Record<string, unknown> } = {}) =>
        this.rows.filter((row) => matches(row, options.where ?? {})).map((row) => ({ ...row }));
    findOne = async (options: { where: Record<string, unknown> }) => {
        const found = this.rows.find((row) => matches(row, options.where));
        return found ? { ...found } : null;
    };
    update = async (criteria: string | Record<string, unknown>, patch: Record<string, unknown>) => {
        const where = typeof criteria === 'string' ? { id: criteria } : criteria;
        for (const row of this.rows) if (matches(row, where)) Object.assign(row, patch);
        return { affected: 1 };
    };
}

function row(overrides: Partial<FleetUsageRow> = {}): FleetUsageRow {
    return {
        provider: 'claude-code',
        providerSessionId: 'sess-1',
        model: 'claude-sonnet-4-5-20250929',
        bucketStart: '2026-10-20T10:00:00.000Z',
        folderBucket: '/home/owner/code/api',
        // 1 M input = $3.00, 100 k output = $1.50 → 450 cents at v1.
        tokens: { in: 1_000_000, out: 100_000, cacheRead: 0, cacheWrite: 0 },
        requests: 4,
        firstAt: '2026-10-20T10:05:00.000Z',
        lastAt: '2026-10-20T10:40:00.000Z',
        ...overrides,
    };
}

function report(rows: FleetUsageRow[], watermark = 10): FleetUsageReport {
    return { watermark, rows, truncated: false, backlogPct: 0 };
}

function harness() {
    const samples = new FakeRepo('sample');
    const sessions = new FakeRepo('session');
    const runs = new FakeRepo('run');
    const jobs = new FakeRepo('job');
    const ledger: Array<{ runId: string; pluginId: string; costCents: number }> = [];
    const pluginUsage = {
        record: jest.fn(async (input: { runId: string; pluginId: string; costCents: number }) => {
            ledger.push({
                runId: input.runId,
                pluginId: input.pluginId,
                costCents: input.costCents,
            });
            return { id: `event-${ledger.length}` };
        }),
    };
    const usageEvents = {
        getRunCostByPlugin: jest.fn(async (runId: string) => {
            const by = new Map<string, number>();
            for (const entry of ledger.filter((line) => line.runId === runId)) {
                by.set(entry.pluginId, (by.get(entry.pluginId) ?? 0) + entry.costCents);
            }
            return [...by.entries()].map(([pluginId, costCents]) => ({ pluginId, costCents }));
        }),
    };
    const stamped: Array<{ runId: string; costCents: number }> = [];
    const runRepository = {
        stampCostCents: jest.fn(async (runId: string, costCents: number) => {
            stamped.push({ runId, costCents });
            await runs.update(runId, { costCents });
        }),
    };
    const nodes = {
        findById: jest.fn(async (id: string) => (id === NODE ? { id: NODE, userId: OWNER } : null)),
    };
    const service = new FleetUsageReconcilerService(
        samples as never,
        sessions as never,
        runs as never,
        jobs as never,
        nodes as never,
        new PublishedModelListPrices(),
        runRepository as never,
        pluginUsage as never,
        usageEvents as never,
    );
    return { service, samples, sessions, runs, jobs, ledger, pluginUsage, stamped };
}

async function seedSession(h: ReturnType<typeof harness>, providerSessionId = 'sess-1') {
    await h.runs.save({
        id: RUN,
        userId: OWNER,
        agentId: AGENT,
        taskId: null,
        workId: null,
        costCents: null,
    } as Row);
    await h.sessions.save({
        id: 'session-a',
        nodeId: NODE,
        provider: 'claude-code',
        providerSessionId,
        agentRunId: RUN,
        kind: 'agent',
        createdAt: new Date('2026-10-20T09:00:00.000Z'),
    } as Row);
}

describe('FleetUsageReconcilerService', () => {
    it('attributes a row to the Session with the same provider session id and rolls it into the Run (ACC-FL20-04)', async () => {
        const h = harness();
        await seedSession(h);
        const summary = await h.service.ingest(NODE, report([row()]));
        expect(summary).toMatchObject({
            accepted: true,
            rows: 1,
            created: 1,
            sessions: 1,
            other: 0,
        });
        const session = h.sessions.rows[0];
        expect(session.costCents).toBe(450);
        expect(session.tokens).toMatchObject({
            priceListVersion: 1,
            requests: 4,
            unknownModels: [],
        });
        expect(h.ledger).toEqual([
            { runId: RUN, pluginId: 'fleet-node:claude-code', costCents: 450 },
        ]);
        expect(h.runs.rows[0].costCents).toBe(450);
        expect(h.samples.rows[0]).toMatchObject({
            fleetSessionId: 'session-a',
            priceListVersion: 1,
            costCents: 450,
        });
    });

    it('re-reporting the same rows changes nothing and writes no second ledger row (U4)', async () => {
        const h = harness();
        await seedSession(h);
        await h.service.ingest(NODE, report([row()]));
        const again = await h.service.ingest(NODE, report([row()]));
        expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
        expect(h.ledger).toHaveLength(1);
        expect(h.runs.rows[0].costCents).toBe(450);
    });

    it('never subtracts: a smaller re-read keeps the stored maximum (U5), a larger one grows the Run by the difference', async () => {
        const h = harness();
        await seedSession(h);
        await h.service.ingest(NODE, report([row()]));
        await h.service.ingest(
            NODE,
            report([
                row({ tokens: { in: 10, out: 10, cacheRead: 0, cacheWrite: 0 }, requests: 1 }),
            ]),
        );
        expect(h.sessions.rows[0].costCents).toBe(450);
        await h.service.ingest(
            NODE,
            report([row({ tokens: { in: 2_000_000, out: 100_000, cacheRead: 0, cacheWrite: 0 } })]),
        );
        expect(h.sessions.rows[0].costCents).toBe(750);
        expect(h.ledger.map((line) => line.costCents)).toEqual([450, 300]);
        expect(h.runs.rows[0].costCents).toBe(750);
    });

    it('keeps an unmatched row as other — no Run, no Agent — and a later Session claims it (ACC-FL20-05, U7)', async () => {
        const h = harness();
        const first = await h.service.ingest(NODE, report([row({ providerSessionId: 'late-1' })]));
        expect(first).toMatchObject({ other: 1, sessions: 0, runs: 0 });
        expect(h.samples.rows[0]).toMatchObject({ fleetSessionId: null, agentRunId: null });
        expect(h.ledger).toEqual([]);
        await seedSession(h, 'late-1');
        await h.service.ingest(
            NODE,
            report([
                row({
                    providerSessionId: 'late-1',
                    bucketStart: '2026-10-20T11:00:00.000Z',
                    firstAt: '2026-10-20T11:00:00.000Z',
                    lastAt: '2026-10-20T11:10:00.000Z',
                }),
            ]),
        );
        expect(h.samples.rows.every((sample) => sample.fleetSessionId === 'session-a')).toBe(true);
        // Both hours now count toward the Session and its Run.
        expect(h.sessions.rows[0].costCents).toBe(900);
        expect(h.runs.rows[0].costCents).toBe(900);
    });

    it('attributes to a Task run by its CLI session on this node when no Session matches', async () => {
        const h = harness();
        await h.runs.save({
            id: TASK_RUN,
            userId: OWNER,
            agentId: AGENT,
            taskId: 'task-1',
            workId: null,
            costCents: null,
            cliSessionId: 'cli-9',
            fleetCliSession: { sessionId: 'cli-9', nodeId: NODE, provider: 'claude-code' },
            createdAt: new Date('2026-10-20T09:00:00.000Z'),
        } as Row);
        const summary = await h.service.ingest(NODE, report([row({ providerSessionId: 'cli-9' })]));
        expect(summary).toMatchObject({ runs: 1, sessions: 0, other: 0 });
        expect(h.samples.rows[0].agentRunId).toBe(TASK_RUN);
        expect(h.ledger).toEqual([
            { runId: TASK_RUN, pluginId: 'fleet-node:claude-code', costCents: 450 },
        ]);
    });

    it('tops up a headless run’s own ledger row instead of counting it twice', async () => {
        const h = harness();
        await seedSession(h);
        // The headless run already reported 300 cents through its CLI summary.
        h.ledger.push({ runId: RUN, pluginId: 'fleet-node:claude-code', costCents: 300 });
        await h.service.ingest(NODE, report([row()]));
        expect(h.ledger.map((line) => line.costCents)).toEqual([300, 150]);
        expect(h.runs.rows[0].costCents).toBe(450);
    });

    it('prices an unknown model in tokens only: no cost, no ledger row, never $0 (FR-8)', async () => {
        const h = harness();
        await seedSession(h);
        await h.service.ingest(NODE, report([row({ model: 'local-7b' })]));
        expect(h.samples.rows[0]).toMatchObject({ costCents: null, priceListVersion: null });
        expect(h.sessions.rows[0].costCents).toBeNull();
        expect(h.sessions.rows[0].tokens).toMatchObject({ unknownModels: ['local-7b'] });
        expect(h.ledger).toEqual([]);
    });

    it('ignores a report over the row cap or for an unknown node, and acknowledges an ingested one', async () => {
        const h = harness();
        const tooMany = report(Array.from({ length: 501 }, () => row()));
        expect((await h.service.ingest(NODE, tooMany)).accepted).toBe(false);
        expect(
            (await h.service.ingest('99999999-9999-4999-8999-999999999999', report([row()])))
                .accepted,
        ).toBe(false);
        await h.jobs.save({ id: 'job-1', result: null } as Row);
        await h.service.ingest(NODE, report([row()], 7), 'job-1');
        expect(h.jobs.rows[0].result).toMatchObject({ watermark: 7 });
        expect(typeof (h.jobs.rows[0].result as Record<string, unknown>).ingestedAt).toBe('string');
    });
});

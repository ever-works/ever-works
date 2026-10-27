import { FindOperator } from 'typeorm';
import { FLEET_USAGE_PAYER_NOTE } from '@ever-works/contracts';
import { FleetUsageViewService } from '../fleet-usage-view.service';
import { PublishedModelListPrices } from '../../../usage/model-list-prices';

/**
 * FL-20 P2 — the Agent filter behind the Budgets tab's rows per computer
 * (FR-14, FR-15) and the schedule rows' last-run / 30-day cost (FR-16).
 */

const OWNER = 'owner-1';
const NODE = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const OTHER_AGENT = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';
const RUN_NEW = '55555555-5555-4555-8555-555555555555';
const RUN_OLD = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-10-21T12:00:00.000Z');

type Row = Record<string, unknown>;

function matches(row: Row, where: Record<string, unknown>): boolean {
    for (const [key, expected] of Object.entries(where)) {
        const actual = row[key];
        if (expected instanceof FindOperator) {
            const type = (expected as unknown as { type: string }).type;
            const value = (expected as unknown as { value: unknown }).value;
            if (type === 'in' && !(value as unknown[]).includes(actual)) return false;
            if (type === 'moreThanOrEqual' && !(new Date(actual as Date).getTime() >= new Date(value as Date).getTime())) {
                return false;
            }
            continue;
        }
        if (actual !== expected) return false;
    }
    return true;
}

const repo = (rows: Row[]) => ({
    find: jest.fn(async (options: { where?: Record<string, unknown> } = {}) =>
        rows.filter((row) => matches(row, options.where ?? {})),
    ),
    findOne: jest.fn(async (options: { where: Record<string, unknown> }) => {
        const found = rows
            .filter((row) => matches(row, options.where))
            .sort((a, b) => new Date(b.createdAt as Date).getTime() - new Date(a.createdAt as Date).getTime());
        return found[0] ?? null;
    }),
});

const sample = (overrides: Row): Row => ({
    nodeId: NODE,
    model: 'claude-sonnet-4-5',
    provider: 'claude-code',
    priceListVersion: 1,
    fleetSessionId: null,
    agentRunId: null,
    checkoutPath: null,
    providerSessionId: 's',
    inputTokens: '1000000',
    outputTokens: '0',
    cacheReadTokens: '0',
    cacheWriteTokens: '0',
    requests: 1,
    ...overrides,
});

function harness(grouped: Row[] = []) {
    const qb: Record<string, jest.Mock> = {};
    for (const name of ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'addGroupBy']) qb[name] = jest.fn(() => qb);
    qb.getRawMany = jest.fn(async () => grouped);
    const storedSamples = [
        // RUN_NEW's Agent session: 1 M input ($3.00).
        sample({ fleetSessionId: 'session-new' }),
        // RUN_OLD directly (a headless Task run): 2 M input ($6.00).
        sample({ agentRunId: RUN_OLD, inputTokens: '2000000' }),
    ];
    const samples = { createQueryBuilder: jest.fn(() => qb), ...repo(storedSamples) };
    const sessions = repo([
        { id: 'session-new', agentRunId: RUN_NEW, agentId: AGENT, kind: 'agent' },
        { id: 'session-x', agentRunId: null, agentId: OTHER_AGENT, kind: 'agent' },
    ]);
    const runs = repo([
        { id: RUN_NEW, taskId: TASK, userId: OWNER, agentId: AGENT, createdAt: new Date('2026-10-20T08:00:00.000Z') },
        { id: RUN_OLD, taskId: TASK, userId: OWNER, agentId: AGENT, createdAt: new Date('2026-10-10T08:00:00.000Z') },
        // Someone else's run of the same Task id is never counted.
        { id: 'run-foreign', taskId: TASK, userId: 'someone-else', agentId: AGENT, createdAt: new Date('2026-10-20T09:00:00.000Z') },
    ]);
    const agents = { find: jest.fn(async () => [{ id: AGENT, name: 'Nina' }]) };
    const checkouts = { find: jest.fn(async () => []) };
    const node = {
        id: NODE,
        userId: OWNER,
        name: 'build-01',
        status: 'online',
        capabilities: ['usage-scan'],
        consents: { work: true, attend: false, manage: false, usageScan: true },
    };
    const nodes = { findByUser: jest.fn(async () => [node]), findById: jest.fn(async () => node) };
    const access = {
        resolveVisible: jest.fn(async () => ({ node, role: 'owner' })),
        listSharedWith: jest.fn(async () => []),
    };
    const scans = { factsFor: jest.fn(async () => new Map()) };
    return new FleetUsageViewService(
        samples as never,
        sessions as never,
        runs as never,
        agents as never,
        checkouts as never,
        nodes as never,
        access as never,
        scans as never,
        new PublishedModelListPrices(),
    );
}

describe('FleetUsageViewService — P2', () => {
    it('filters the view to one Agent’s sessions and Task runs, with no "other" sessions', async () => {
        const view = await harness([
            sample({ fleetSessionId: 'session-new' }),
            sample({ fleetSessionId: 'session-x', inputTokens: '5000000' }),
            sample({ agentRunId: RUN_OLD, inputTokens: '2000000' }),
            sample({ providerSessionId: 'keyboard', inputTokens: '9000000' }),
        ]).view(OWNER, { days: 30, agentId: AGENT }, NOW);
        expect(view.agentId).toBe(AGENT);
        // $3.00 (its session) + $6.00 (its Task run) — not the other Agent's or the keyboard session.
        expect(view.totals.costCents).toBe(900);
        expect(view.byNode[0]).toMatchObject({ name: 'build-01', costCents: 900 });
        expect(view.sessions.other).toEqual({ sessions: 0, costCents: null });
        expect(view.note).toBe(FLEET_USAGE_PAYER_NOTE);
    });

    it('answers each recurring Task’s newest Run and its 30-day total from the owner’s own Runs (FR-16)', async () => {
        const result = await harness().taskCosts(OWNER, [TASK, 'not-a-uuid'], NOW);
        expect(result.note).toBe(FLEET_USAGE_PAYER_NOTE);
        expect(result.tasks).toEqual([
            {
                taskId: TASK,
                lastRun: { runId: RUN_NEW, at: '2026-10-20T08:00:00.000Z', costCents: 300 },
                last30DaysCents: 900,
                runs30Days: 2,
            },
        ]);
    });

    it('answers an empty line for a Task that never ran', async () => {
        const result = await harness().taskCosts(OWNER, ['77777777-7777-4777-8777-777777777777'], NOW);
        expect(result.tasks).toEqual([
            { taskId: '77777777-7777-4777-8777-777777777777', lastRun: null, last30DaysCents: null, runs30Days: 0 },
        ]);
    });
});

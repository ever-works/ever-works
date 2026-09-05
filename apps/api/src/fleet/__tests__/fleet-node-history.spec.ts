import { FLEET_JOB_MAX_ERROR_LENGTH } from '@ever-works/contracts';
import type { FleetNodeJobHistoryEntry } from '@ever-works/contracts';
import {
    buildNodeJobHistory,
    isFailedNodeHistoryEntry,
    nodeHistoryRunIds,
    type ReconcilableRun,
} from '../fleet-node-history';

/**
 * The node drawer's history composition (fleet health signals, EW-776).
 *
 * Three defects are pinned here, and one of them is a disclosure risk
 * rather than a display bug:
 *
 *  - a job whose RUN failed used to render as a calm "done", because the
 *    drawer only ever saw the job status;
 *  - a failed job showed a red badge and no reason, because the error
 *    text never left the server;
 *  - `payload` — executor input composed from user content, bounded only
 *    by `FLEET_JOB_MAX_PAYLOAD_BYTES` — was on the wire of a settings
 *    endpoint for no one to render. It is stripped here rather than
 *    "just not rendered", so nothing downstream can start rendering it.
 */

const RUN_ID = '99999999-9999-4999-8999-999999999999';
const TASK_ID = '88888888-8888-4888-8888-888888888888';
const AGENT_ID = '77777777-7777-4777-8777-777777777777';

const job = (over: Partial<FleetNodeJobHistoryEntry> = {}): FleetNodeJobHistoryEntry =>
    ({
        id: 'job-1',
        kind: 'agent-task',
        status: 'done',
        nodeId: 'node-1',
        targetNodeId: null,
        requiredCapabilities: [],
        payload: { runId: RUN_ID, taskId: TASK_ID, agentId: AGENT_ID },
        leaseExpiresAt: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: null,
        startedAt: null,
        completedAt: null,
        leaseGeneration: 1,
        ...over,
    }) as FleetNodeJobHistoryEntry;

const run = (over: Partial<ReconcilableRun> = {}): ReconcilableRun => ({
    id: RUN_ID,
    status: 'completed',
    summary: 'Added the missing guard and a spec',
    errorMessage: null,
    ...over,
});

describe('buildNodeJobHistory', () => {
    it('never lets the payload reach the wire', () => {
        const secret = { runId: RUN_ID, taskId: TASK_ID, instructions: 'PAYLOAD-SENTINEL' };

        const [entry] = buildNodeJobHistory([job({ payload: secret })]);

        expect(entry.payload).toBeNull();
        expect(JSON.stringify(entry)).not.toContain('PAYLOAD-SENTINEL');
    });

    it('replaces it with an IDS-ONLY summary an operator can follow', () => {
        const [entry] = buildNodeJobHistory([job()]);

        expect(entry.summary).toEqual({
            kind: 'agent-task',
            taskId: TASK_ID,
            runId: RUN_ID,
            agentId: AGENT_ID,
        });
    });

    it('maps the reconciled run outcome onto the row', () => {
        const [entry] = buildNodeJobHistory(
            [job()],
            new Map([[RUN_ID, run({ status: 'failed', errorMessage: 'model refused the plan' })]]),
        );

        expect(entry.reconciled).toEqual({
            runId: RUN_ID,
            status: 'failed',
            summary: 'Added the missing guard and a spec',
            error: 'model refused the plan',
        });
    });

    it('surfaces a FAILED run behind a job the node called done', () => {
        // The whole point: the job settled fine and the run did not, and
        // the drawer used to show only the first half.
        const [entry] = buildNodeJobHistory(
            [job({ status: 'done' })],
            new Map([[RUN_ID, run({ status: 'failed', summary: null, errorMessage: 'blew up' })]]),
        );

        expect(entry.status).toBe('done');
        expect(entry.reconciled?.status).toBe('failed');
        expect(entry.reconciled?.error).toBe('blew up');
    });

    it('reports reconciled: null when the run could not be read', () => {
        // The run read is best-effort at the edge. "Not known" must never
        // be dressed up as an outcome.
        const [entry] = buildNodeJobHistory([job()], new Map());

        expect(entry.reconciled).toBeNull();
    });

    it('reports reconciled: null for a job that carries no run at all', () => {
        const [entry] = buildNodeJobHistory([
            job({ kind: 'acceptance-checks', payload: { workId: 'w1' } }),
        ]);

        expect(entry.reconciled).toBeNull();
        expect(entry.summary).toEqual({
            kind: 'acceptance-checks',
            taskId: null,
            runId: null,
            agentId: null,
        });
    });

    it("passes the job's own error text through", () => {
        const [entry] = buildNodeJobHistory([
            job({ status: 'failed', error: 'pnpm install exploded' }),
        ]);

        expect(entry.error).toBe('pnpm install exploded');
    });

    it('caps both error texts at the contract bound', () => {
        const long = 'x'.repeat(FLEET_JOB_MAX_ERROR_LENGTH + 500);

        const [entry] = buildNodeJobHistory(
            [job({ status: 'failed', error: long })],
            new Map([[RUN_ID, run({ status: 'failed', errorMessage: long })]]),
        );

        expect(entry.error).toHaveLength(FLEET_JOB_MAX_ERROR_LENGTH);
        expect(entry.reconciled?.error).toHaveLength(FLEET_JOB_MAX_ERROR_LENGTH);
    });

    it('normalises an unrecognised run status instead of leaking it', () => {
        const [entry] = buildNodeJobHistory(
            [job()],
            new Map([[RUN_ID, run({ status: 'archived' as never })]]),
        );

        expect(entry.reconciled?.status).toBe('queued');
    });

    it('treats blank text as absent rather than rendering an empty reason', () => {
        const [entry] = buildNodeJobHistory(
            [job({ error: '   ' })],
            new Map([[RUN_ID, run({ summary: '', errorMessage: '  ' })]]),
        );

        expect(entry.error).toBeNull();
        expect(entry.reconciled?.summary).toBeNull();
        expect(entry.reconciled?.error).toBeNull();
    });

    it('keeps every other job field untouched', () => {
        const [entry] = buildNodeJobHistory([
            job({ id: 'job-9', attempts: 3, queuedReason: 'waiting-for-runner' }),
        ]);

        expect(entry.id).toBe('job-9');
        expect(entry.attempts).toBe(3);
        expect(entry.queuedReason).toBe('waiting-for-runner');
    });
});

describe('nodeHistoryRunIds', () => {
    it('collects the run ids the page correlates to', () => {
        expect(nodeHistoryRunIds([job()])).toEqual([RUN_ID]);
    });

    it('deduplicates — a retried Task appears as several jobs on one run', () => {
        expect(nodeHistoryRunIds([job({ id: 'a' }), job({ id: 'b' })])).toEqual([RUN_ID]);
    });

    it('ignores jobs that carry no run', () => {
        expect(nodeHistoryRunIds([job({ kind: 'acceptance-checks', payload: null })])).toEqual([]);
    });
});

/**
 * The failed SUBSET the drawer is handed alongside the full list. It has
 * to be judged the same way the badge on each row is judged, or the
 * endpoint ships the original defect one layer up: a row rendering a red
 * "Failed" in the full list and missing from the failed one beside it.
 */
describe('isFailedNodeHistoryEntry', () => {
    const withRun = (
        jobStatus: FleetNodeJobHistoryEntry['status'],
        runStatus: NonNullable<FleetNodeJobHistoryEntry['reconciled']>['status'],
    ) =>
        buildNodeJobHistory(
            [job({ status: jobStatus })],
            new Map<string, ReconcilableRun>([[RUN_ID, { id: RUN_ID, status: runStatus }]]),
        )[0];

    it('counts a job the node called done whose RUN failed', () => {
        expect(isFailedNodeHistoryEntry(withRun('done', 'failed'))).toBe(true);
    });

    it('does NOT count a job the node called failed whose run the reconciler completed', () => {
        expect(isFailedNodeHistoryEntry(withRun('failed', 'completed'))).toBe(false);
    });

    it('falls back to the job status when there is no reconciled outcome', () => {
        const [failed] = buildNodeJobHistory([job({ status: 'failed', payload: null })]);
        const [done] = buildNodeJobHistory([job({ status: 'done', payload: null })]);

        expect(isFailedNodeHistoryEntry(failed)).toBe(true);
        expect(isFailedNodeHistoryEntry(done)).toBe(false);
    });
});

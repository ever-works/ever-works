import { describe, expect, it } from 'vitest';
import type { RunLedgerRow } from '@ever-works/contracts';
import {
    buildRunsSearch,
    countActiveFilters,
    formatCents,
    formatRunDuration,
    formatTokens,
    hasOpenRuns,
    isSearchUsable,
    isTypingTarget,
    mergeRefreshedRows,
    parseRunsViewState,
    runElapsedMs,
    stepAnchorDate,
    windowIncludesNow,
} from './runs.shared';

/**
 * Runs ledger (AW-09) — the pure helpers behind the Runs page: the URL is
 * the view (shareable, reload-safe), stepping moves by exactly one unit,
 * a refresh never reorders what is on screen, and "not measured" never
 * formats as zero.
 */

const AGENT = '0b7e7c1e-6f6a-4c55-9a4c-1f2b3c4d5e6f';
const RUN = '9f9f9f9f-6f6a-4c55-9a4c-1f2b3c4d5e6f';

function params(query: string) {
    const search = new URLSearchParams(query);
    return { get: (name: string) => search.get(name) };
}

function row(id: string, over: Partial<RunLedgerRow> = {}): RunLedgerRow {
    return {
        id,
        agentId: AGENT,
        agentName: 'Ops',
        agentArchived: false,
        triggerKind: 'task',
        status: 'completed',
        startedAt: '2026-09-08T09:00:00.000Z',
        createdAt: '2026-09-08T08:59:00.000Z',
        finishedAt: '2026-09-08T09:04:55.000Z',
        durationMs: 295_000,
        costCents: 31,
        totalTokens: 900,
        summary: null,
        errorMessage: null,
        currentActivity: null,
        taskId: null,
        taskTitle: null,
        missionId: null,
        missionTitle: null,
        workId: null,
        workName: null,
        scheduleKey: null,
        awaitingInput: false,
        queuedReason: null,
        attentionReason: null,
        ...over,
    };
}

describe('runs.shared', () => {
    describe('URL view state', () => {
        it('round-trips granularity, date, filters and the open receipt', () => {
            const state = parseRunsViewState(
                params(
                    `g=week&d=2026-09-08&agent=${AGENT}&kind=heartbeat,chat&status=failed&q=deploy&run=${RUN}`,
                ),
            );

            expect(state).toEqual({
                granularity: 'week',
                date: '2026-09-08',
                filters: {
                    agentIds: [AGENT],
                    triggerKinds: ['heartbeat', 'chat'],
                    statuses: ['failed'],
                    search: 'deploy',
                },
                runId: RUN,
            });
            expect(parseRunsViewState(params(buildRunsSearch(state)))).toEqual(state);
        });

        it('defaults to Day / today with no filters and drops invalid values', () => {
            const state = parseRunsViewState(
                params('g=year&d=yesterday&agent=nope&kind=cron&status=exploded&q=a&run=123'),
            );

            expect(state).toEqual({ granularity: 'day', date: null, filters: {}, runId: null });
        });

        it('drops a well-shaped date that names no real calendar day', () => {
            for (const d of [
                '2026-02-31',
                '2026-02-29',
                '2026-13-01',
                '2026-04-31',
                '2026-09-00',
            ]) {
                expect(parseRunsViewState(params(`g=day&d=${d}`)).date).toBeNull();
            }
            expect(parseRunsViewState(params('g=day&d=2028-02-29')).date).toBe('2028-02-29');
        });

        it('uses the fallback granularity when the URL names none', () => {
            expect(parseRunsViewState(params(''), 'month').granularity).toBe('month');
        });
    });

    describe('stepAnchorDate', () => {
        it('moves a day, a week or a month at a time', () => {
            expect(stepAnchorDate('2026-09-08', 'day', -1)).toBe('2026-09-07');
            expect(stepAnchorDate('2026-12-31', 'day', 1)).toBe('2027-01-01');
            expect(stepAnchorDate('2026-09-08', 'week', -1)).toBe('2026-09-01');
            expect(stepAnchorDate('2026-09-08', 'week', 1)).toBe('2026-09-15');
        });

        it('never skips a month when stepping from the 31st', () => {
            expect(stepAnchorDate('2026-01-31', 'month', 1)).toBe('2026-02-01');
            expect(stepAnchorDate('2026-03-31', 'month', -1)).toBe('2026-02-01');
        });
    });

    describe('filters', () => {
        it('counts active dimensions, not values', () => {
            expect(countActiveFilters({})).toBe(0);
            expect(
                countActiveFilters({
                    agentIds: [AGENT, AGENT],
                    statuses: ['failed', 'cancelled'],
                    search: 'deploy',
                }),
            ).toBe(3);
        });

        it('accepts searches of 2 to 200 characters only', () => {
            expect(isSearchUsable('a')).toBe(false);
            expect(isSearchUsable(' a ')).toBe(false);
            expect(isSearchUsable('ab')).toBe(true);
            expect(isSearchUsable('x'.repeat(201))).toBe(false);
        });
    });

    describe('live refresh', () => {
        it('polls only a window that contains now and only with open runs', () => {
            const window = { from: '2026-09-08T00:00:00.000Z', to: '2026-09-09T00:00:00.000Z' };
            expect(windowIncludesNow(window, Date.parse('2026-09-08T12:00:00.000Z'))).toBe(true);
            expect(windowIncludesNow(window, Date.parse('2026-09-09T00:00:00.000Z'))).toBe(false);
            expect(hasOpenRuns([row('a'), row('b', { status: 'running' })])).toBe(true);
            expect(hasOpenRuns([row('a'), row('b', { status: 'failed' })])).toBe(false);
        });

        it('merges refreshed rows in place, prepends new ones and keeps loaded pages', () => {
            const current = [row('a', { status: 'running' }), row('b'), row('older-page')];
            const fresh = [row('new'), row('a', { status: 'completed' }), row('b')];

            const merged = mergeRefreshedRows(current, fresh);

            expect(merged.map((r) => r.id)).toEqual(['new', 'a', 'b', 'older-page']);
            expect(merged[1].status).toBe('completed');
        });
    });

    describe('formatting keeps "not measured" apart from zero', () => {
        it('formats cents, and returns null — not $0.00 — for a missing cost', () => {
            expect(formatCents(31, 'en-US')).toBe('$0.31');
            expect(formatCents(0, 'en-US')).toBe('$0.00');
            expect(formatCents(null, 'en-US')).toBeNull();
            expect(formatCents(undefined, 'en-US')).toBeNull();
        });

        it('formats tokens compactly and returns null when not reported', () => {
            expect(formatTokens(412_000, 'en-US')).toBe('412K');
            expect(formatTokens(0, 'en-US')).toBe('0');
            expect(formatTokens(null, 'en-US')).toBeNull();
        });

        it('formats run durations and refuses nonsense', () => {
            expect(formatRunDuration(31_000)).toBe('31s');
            expect(formatRunDuration(295_000)).toBe('4m 55s');
            expect(formatRunDuration(3_840_000)).toBe('1h 04m');
            expect(formatRunDuration(null)).toBeNull();
            expect(formatRunDuration(-1)).toBeNull();
        });

        it('derives a live elapsed time for a run without a recorded duration', () => {
            const running = row('r', {
                status: 'running',
                durationMs: null,
                finishedAt: null,
                startedAt: '2026-09-08T09:00:00.000Z',
            });
            expect(runElapsedMs(running, Date.parse('2026-09-08T09:04:02.000Z'))).toBe(242_000);
            expect(runElapsedMs(row('q', { durationMs: null, startedAt: null }))).toBeNull();
        });
    });

    describe('isTypingTarget', () => {
        it('recognises inputs, textareas, selects and editable content', () => {
            expect(isTypingTarget(document.createElement('input'))).toBe(true);
            expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
            expect(isTypingTarget(document.createElement('select'))).toBe(true);
            const editable = document.createElement('div');
            editable.setAttribute('contenteditable', 'true');
            expect(isTypingTarget(editable)).toBe(true);
            expect(isTypingTarget(document.createElement('button'))).toBe(false);
            expect(isTypingTarget(null)).toBe(false);
        });
    });
});

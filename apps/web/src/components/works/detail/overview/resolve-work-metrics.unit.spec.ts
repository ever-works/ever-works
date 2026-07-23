import { describe, expect, it } from 'vitest';
import { getWorkCapabilities, WORK_KINDS } from '@ever-works/contracts';
import {
    resolveWorkMetric,
    resolveWorkMetrics,
    type WorkMetricInputs,
} from './resolve-work-metrics';

const INPUTS: WorkMetricInputs = {
    itemsCount: 12,
    categoriesCount: 4,
    tagsCount: 7,
    comparisonsCount: 2,
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    hasDeployment: true,
    generationStatusLabel: 'Generated',
    deployStatusLabel: 'Live',
};

describe('resolveWorkMetric', () => {
    it.each([
        ['total-items', 12],
        ['posts', 12],
        ['categories', 4],
        ['tags', 7],
        ['comparisons', 2],
    ] as const)('resolves %s from the Work payload', (id, expected) => {
        expect(resolveWorkMetric(id, INPUTS)).toEqual({ id, state: 'ok', value: expected });
    });

    it('derives days-active from createdAt', () => {
        expect(resolveWorkMetric('days-active', INPUTS)).toEqual({
            id: 'days-active',
            state: 'ok',
            value: 5,
        });
    });

    it('never reports a negative age for a future createdAt', () => {
        const future = { ...INPUTS, createdAt: new Date(Date.now() + 86_400_000).toISOString() };
        expect(resolveWorkMetric('days-active', future)).toEqual({
            id: 'days-active',
            state: 'ok',
            value: 0,
        });
    });

    it('treats an unparseable createdAt as zero rather than NaN', () => {
        const bad = { ...INPUTS, createdAt: 'not-a-date' };
        expect(resolveWorkMetric('days-active', bad).value).toBe(0);
    });

    it('reports deploy status only once the Work is deployed', () => {
        expect(resolveWorkMetric('deploy-status', INPUTS)).toEqual({
            id: 'deploy-status',
            state: 'ok',
            value: 'Live',
        });
        expect(resolveWorkMetric('deploy-status', { ...INPUTS, hasDeployment: false })).toEqual({
            id: 'deploy-status',
            state: 'not_deployed',
        });
    });

    /**
     * The whole point of `WorkMetricState`. "We have no analytics connected"
     * and "you had zero page views" are different claims, and rendering the
     * second for the first reads as a broken product.
     */
    it.each(['page-views', 'sessions', 'conversions'] as const)(
        'reports %s as not_configured rather than 0',
        (id) => {
            const result = resolveWorkMetric(id, INPUTS);
            expect(result.state).toBe('not_configured');
            expect(result.value).toBeUndefined();
        },
    );

    it.each(['registered-users', 'team-members', 'agents', 'open-tasks', 'works-owned'] as const)(
        'reports the server-resolved metric %s as not_configured until the endpoint lands',
        (id) => {
            expect(resolveWorkMetric(id, INPUTS).state).toBe('not_configured');
        },
    );
});

describe('resolveWorkMetrics', () => {
    it('preserves the requested order', () => {
        const ids = ['days-active', 'total-items', 'categories'] as const;
        expect(resolveWorkMetrics(ids, INPUTS).map((m) => m.id)).toEqual([...ids]);
    });

    /**
     * Every metric any kind can ask for must resolve to a real state — a
     * missing branch would surface as `state: 'error'` on a live tile.
     */
    it.each(WORK_KINDS)('resolves every tile for the %s kind without erroring', (kind) => {
        const metrics = resolveWorkMetrics(getWorkCapabilities(kind).metrics, INPUTS);
        expect(metrics).toHaveLength(getWorkCapabilities(kind).metrics.length);
        for (const metric of metrics) {
            expect(metric.state).not.toBe('error');
        }
    });

    it('keeps the legacy five tiles resolvable for the default kind', () => {
        const metrics = resolveWorkMetrics(getWorkCapabilities('default').metrics, INPUTS);
        expect(metrics.every((m) => m.state === 'ok')).toBe(true);
    });
});

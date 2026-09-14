import type { DataSource } from 'typeorm';
import type { WorkspaceSearchKind } from '@ever-works/contracts/api';
import {
    WorkspaceSearchService,
    type WorkspaceSearchSourceReader,
} from '../workspace-search.service';
import type {
    WorkspaceSearchCandidate,
    WorkspaceSearchScope,
    WorkspaceSearchSourceQuery,
    WorkspaceSearchSourceResult,
} from '../workspace-search.types';

const SCOPE: WorkspaceSearchScope = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    organizationId: 'org-1',
};

function candidate(
    kind: WorkspaceSearchKind,
    title: string,
    extra: Partial<WorkspaceSearchCandidate> = {},
) {
    return {
        kind,
        sourceId: `${kind}-${title.toLowerCase().replace(/\s+/g, '-')}`,
        title,
        identifier: null,
        secondary: [],
        subtitle: null,
        statusLabel: null,
        destination: `/${kind}s/${title}`,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        ...extra,
    } satisfies WorkspaceSearchCandidate;
}

type Handler = (query: WorkspaceSearchSourceQuery) => Promise<WorkspaceSearchSourceResult>;

function build(handlers: Partial<Record<WorkspaceSearchKind, Handler>>) {
    const calls: Array<{ kind: WorkspaceSearchKind; query: WorkspaceSearchSourceQuery }> = [];
    const reader: WorkspaceSearchSourceReader = {
        kinds: () => Object.keys(handlers) as WorkspaceSearchKind[],
        read: (kind, query) => {
            calls.push({ kind, query });
            const handler = handlers[kind];
            return handler ? handler(query) : Promise.resolve({ candidates: [], total: 0 });
        },
    };
    const service = new WorkspaceSearchService({} as DataSource, reader);
    return { service, calls };
}

const ok =
    (candidates: WorkspaceSearchCandidate[], total = candidates.length): Handler =>
    async () => ({ candidates, total });

describe('WorkspaceSearchService', () => {
    it('issues no source read for a query shorter than two characters', async () => {
        const { service, calls } = build({ mission: ok([candidate('mission', 'Invoice')]) });
        const response = await service.search(SCOPE, { query: ' i ' });
        expect(calls).toHaveLength(0);
        expect(response).toMatchObject({
            query: 'i',
            groups: [],
            degradedKinds: [],
            servedBy: 'fanout',
        });
    });

    it('fans out to every available source with the caller scope and escaped patterns', async () => {
        const { service, calls } = build({
            mission: ok([]),
            task: ok([]),
            knowledge: ok([]),
        });
        await service.search(SCOPE, { query: '100%_off' });
        expect(calls.map((c) => c.kind).sort()).toEqual(['knowledge', 'mission', 'task']);
        for (const call of calls) {
            expect(call.query.scope).toBe(SCOPE);
            expect(call.query.containsPattern).toBe('%100\\%\\_off%');
        }
    });

    it('returns Missions and Tasks as two distinct groups for a query matching both', async () => {
        const { service } = build({
            task: ok([
                candidate('task', 'Invoice follow-up'),
                candidate('task', 'Late invoice sweep'),
            ]),
            mission: ok([candidate('mission', 'Invoice reconciliation')]),
        });
        const response = await service.search(SCOPE, { query: 'invoice' });
        expect(response.groups.map((g) => g.kind)).toEqual(['mission', 'task']);
        expect(response.groups[0].hits.every((h) => h.kind === 'mission')).toBe(true);
        expect(response.groups[1].hits.every((h) => h.kind === 'task')).toBe(true);
        expect(response.groups[1].hits.map((h) => h.id)).toEqual([
            'task:task-invoice-follow-up',
            'task:task-late-invoice-sweep',
        ]);
    });

    it('degrades a throwing source instead of failing the request', async () => {
        const { service } = build({
            mission: ok([candidate('mission', 'Invoice reconciliation')]),
            knowledge: async () => {
                throw new Error('connection reset');
            },
        });
        const response = await service.search(SCOPE, { query: 'invoice' });
        expect(response.degradedKinds).toEqual(['knowledge']);
        expect(response.groups.map((g) => g.kind)).toEqual(['mission']);
    });

    it('caps rows per group, keeps the pre-cap total, and caps the whole response', async () => {
        const many = (kind: WorkspaceSearchKind) =>
            ok(
                Array.from({ length: 30 }, (_, i) =>
                    candidate(kind, `Invoice ${String(i).padStart(2, '0')}`),
                ),
                137,
            );
        const { service, calls } = build({
            mission: many('mission'),
            task: many('task'),
            agent: many('agent'),
        });

        const defaults = await service.search(SCOPE, { query: 'invoice' });
        expect(defaults.groups.map((g) => g.hits.length)).toEqual([5, 5, 5]);
        expect(defaults.groups[1].total).toBe(137);
        expect(calls[0].query.cap).toBe(25);

        const filtered = await service.search(SCOPE, {
            query: 'invoice',
            perKindLimit: 999,
            limit: 999,
        });
        expect(filtered.groups.map((g) => g.hits.length)).toEqual([25, 25, 10]);
    });

    it('restricts to requested kinds and ignores kinds with no source', async () => {
        const { service, calls } = build({
            mission: ok([]),
            task: ok([candidate('task', 'Invoice')]),
        });
        const response = await service.search(SCOPE, { query: 'invoice', kinds: ['task', 'run'] });
        expect(calls.map((c) => c.kind)).toEqual(['task']);
        expect(response.groups.map((g) => g.kind)).toEqual(['task']);
    });

    it('drops candidates the ranker does not consider a match', async () => {
        const { service } = build({ mission: ok([candidate('mission', 'Unrelated title')], 1) });
        const response = await service.search(SCOPE, { query: 'invoice' });
        expect(response.groups).toEqual([]);
    });

    it('boosts a recently opened record above an otherwise equal one', async () => {
        const { service } = build({
            mission: ok([
                candidate('mission', 'Q3 alpha plan'),
                candidate('mission', 'Q3 beta plan'),
            ]),
        });
        const plain = await service.search(SCOPE, { query: 'q3' });
        expect(plain.groups[0].hits[0].title).toBe('Q3 alpha plan');

        const boosted = await service.search(SCOPE, {
            query: 'q3',
            recent: ['mission:mission-q3-beta-plan'],
        });
        expect(boosted.groups[0].hits[0].title).toBe('Q3 beta plan');
        expect(boosted.groups[0].hits[0].score).toBe(100);
    });

    it('truncates an over-long query instead of rejecting it', async () => {
        const { service, calls } = build({ mission: ok([]) });
        const response = await service.search(SCOPE, { query: 'x'.repeat(500) });
        expect(response.query).toHaveLength(128);
        expect(calls[0].query.containsPattern).toBe(`%${'x'.repeat(128)}%`);
    });
});

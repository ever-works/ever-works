import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    BackfillManagedSubdomainService,
    planForWork,
    type CloudflareDnsRecord,
    type CloudflareZoneLister,
    type WorkBackfillReadWrite,
} from '../backfill-managed-subdomain.service';
import type { Work } from '@ever-works/agent/entities';

/**
 * Test fixtures — mirror the seven legacy Works listed in spec §5 so the
 * tests actually exercise the same shapes ops will run against.
 */

function makeWork(partial: Partial<Work> & { id: string; slug: string }): Work {
    return {
        deployProvider: 'ever-works',
        managedSubdomain: null,
        ...partial,
    } as Work;
}

function makeRecord(name: string, type: 'CNAME' | 'A' = 'CNAME'): CloudflareDnsRecord {
    return {
        id: `rec_${name.replace(/\W/g, '_')}`,
        name,
        type,
        content: 'platform.k8s-works.ever.works',
    };
}

function makeLister(
    records: CloudflareDnsRecord[],
    rootDomain = 'ever.works',
): CloudflareZoneLister {
    return {
        listAllRecords: vi.fn(async () => records),
        rootDomain: () => rootDomain,
    };
}

function makeWorksAdapter(works: Work[]): WorkBackfillReadWrite & {
    update: ReturnType<typeof vi.fn>;
} {
    return {
        findCandidatesForBackfill: vi.fn(async () => works),
        update: vi.fn(async () => undefined),
    };
}

const silentLogger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
};

beforeEach(() => {
    silentLogger.log.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
});

describe('planForWork', () => {
    const rootDomain = 'ever.works';
    const zone = {
        byLabel: new Map<string, CloudflareDnsRecord>([
            ['dir', makeRecord('dir.ever.works')],
            ['mcpserver', makeRecord('mcpserver.ever.works')],
            ['ai-coding-1234', makeRecord('ai-coding-1234.ever.works')],
        ]),
        labels: new Set(['dir', 'mcpserver', 'ai-coding-1234']),
    };

    it('returns already-set when work already has managedSubdomain', () => {
        const work = makeWork({ id: 'w1', slug: 'dir', managedSubdomain: 'something' });
        const entry = planForWork(work, zone, rootDomain);
        expect(entry.kind).toBe('already-set');
    });

    it('returns exact-slug match when slug matches a zone label uniquely', () => {
        const work = makeWork({ id: 'aaaa-bbbb-cccc-dddd', slug: 'dir' });
        const entry = planForWork(work, zone, rootDomain);
        expect(entry).toMatchObject({
            kind: 'match',
            managedSubdomain: 'dir',
            fqdn: 'dir.ever.works',
            via: 'exact-slug',
        });
    });

    it('returns slug-with-short-id-suffix match when suffix uniquely matches', () => {
        // shortId of '12345678-...' is '1234'
        const work = makeWork({ id: '12345678-0000-0000-0000-000000000000', slug: 'ai-coding' });
        const entry = planForWork(work, zone, rootDomain);
        expect(entry).toMatchObject({
            kind: 'match',
            managedSubdomain: 'ai-coding-1234',
            via: 'slug-with-short-id-suffix',
        });
    });

    it('returns no-candidate when neither exact nor suffixed label exists in zone', () => {
        const work = makeWork({ id: 'aaaa-bbbb-cccc-dddd', slug: 'not-in-zone' });
        const entry = planForWork(work, zone, rootDomain);
        expect(entry.kind).toBe('no-candidate');
    });

    it('returns ambiguous when both exact AND suffix labels exist in zone', () => {
        // Build a zone where both `dir` and `dir-1234` exist.
        const ambiguousZone = {
            byLabel: new Map<string, CloudflareDnsRecord>([
                ['dir', makeRecord('dir.ever.works')],
                ['dir-1234', makeRecord('dir-1234.ever.works')],
            ]),
            labels: new Set(['dir', 'dir-1234']),
        };
        const work = makeWork({ id: '12345678-aaaa-bbbb-cccc-dddddddddddd', slug: 'dir' });
        const entry = planForWork(work, ambiguousZone, rootDomain);
        expect(entry).toMatchObject({
            kind: 'ambiguous',
            candidates: expect.arrayContaining(['dir', 'dir-1234']),
        });
    });
});

describe('BackfillManagedSubdomainService', () => {
    const rootDomain = 'ever.works';

    it('dry-run logs intended writes but persists nothing', async () => {
        const records = [
            makeRecord('dir.ever.works'),
            makeRecord('mcpserver.ever.works'),
            makeRecord('unrelated.ever.works'),
        ];
        const works = [
            makeWork({ id: '11111111-aaaa-bbbb-cccc-dddddddddddd', slug: 'dir' }),
            makeWork({ id: '22222222-aaaa-bbbb-cccc-dddddddddddd', slug: 'mcpserver' }),
        ];
        const cloudflare = makeLister(records, rootDomain);
        const adapter = makeWorksAdapter(works);
        const svc = new BackfillManagedSubdomainService(adapter, cloudflare, silentLogger);

        const summary = await svc.run({ write: false });

        expect(summary.matched).toBe(2);
        expect(summary.persisted).toBe(0);
        expect(summary.totalScanned).toBe(2);
        expect(adapter.update).not.toHaveBeenCalled();
        // The PLAN log line is the contract — verify it ran for each match.
        const planLogs = silentLogger.log.mock.calls
            .map((args) => String(args[0]))
            .filter((line) => line.includes('PLAN'));
        expect(planLogs).toHaveLength(2);
    });

    it('--write persists matches via the adapter', async () => {
        const records = [makeRecord('dir.ever.works'), makeRecord('mcpserver.ever.works')];
        const works = [
            makeWork({ id: '11111111-aaaa-bbbb-cccc-dddddddddddd', slug: 'dir' }),
            makeWork({ id: '22222222-aaaa-bbbb-cccc-dddddddddddd', slug: 'mcpserver' }),
        ];
        const cloudflare = makeLister(records, rootDomain);
        const adapter = makeWorksAdapter(works);
        const svc = new BackfillManagedSubdomainService(adapter, cloudflare, silentLogger);

        const summary = await svc.run({ write: true });

        expect(summary.matched).toBe(2);
        expect(summary.persisted).toBe(2);
        expect(adapter.update).toHaveBeenCalledTimes(2);
        expect(adapter.update).toHaveBeenCalledWith('11111111-aaaa-bbbb-cccc-dddddddddddd', {
            managedSubdomain: 'dir',
        });
        expect(adapter.update).toHaveBeenCalledWith('22222222-aaaa-bbbb-cccc-dddddddddddd', {
            managedSubdomain: 'mcpserver',
        });
    });

    it('ambiguous matches are logged and NOT persisted', async () => {
        const records = [makeRecord('dir.ever.works'), makeRecord('dir-1111.ever.works')];
        const work = makeWork({
            // shortId === '1111'
            id: '11111111-0000-0000-0000-000000000000',
            slug: 'dir',
        });
        const cloudflare = makeLister(records, rootDomain);
        const adapter = makeWorksAdapter([work]);
        const svc = new BackfillManagedSubdomainService(adapter, cloudflare, silentLogger);

        const summary = await svc.run({ write: true });

        expect(summary.ambiguous).toBe(1);
        expect(summary.persisted).toBe(0);
        expect(adapter.update).not.toHaveBeenCalled();
        const ambiguousLogs = silentLogger.warn.mock.calls
            .map((args) => String(args[0]))
            .filter((line) => line.includes('AMBIGUOUS'));
        expect(ambiguousLogs).toHaveLength(1);
    });

    it('skips Works that already have managedSubdomain set', async () => {
        const records = [makeRecord('dir.ever.works')];
        const works = [
            makeWork({
                id: '11111111-aaaa-bbbb-cccc-dddddddddddd',
                slug: 'dir',
                managedSubdomain: 'dir-old',
            }),
        ];
        const cloudflare = makeLister(records, rootDomain);
        const adapter = makeWorksAdapter(works);
        const svc = new BackfillManagedSubdomainService(adapter, cloudflare, silentLogger);

        const summary = await svc.run({ write: true });

        expect(summary.alreadySet).toBe(1);
        expect(summary.matched).toBe(0);
        expect(summary.persisted).toBe(0);
        expect(adapter.update).not.toHaveBeenCalled();
    });

    it('Works with no candidate in zone are counted but not persisted', async () => {
        const records = [makeRecord('something-else.ever.works')];
        const works = [
            makeWork({ id: '11111111-aaaa-bbbb-cccc-dddddddddddd', slug: 'orphan-work' }),
        ];
        const cloudflare = makeLister(records, rootDomain);
        const adapter = makeWorksAdapter(works);
        const svc = new BackfillManagedSubdomainService(adapter, cloudflare, silentLogger);

        const summary = await svc.run({ write: true });

        expect(summary.noCandidate).toBe(1);
        expect(summary.matched).toBe(0);
        expect(adapter.update).not.toHaveBeenCalled();
    });

    it('ignores zone records under a different root domain', async () => {
        const records = [makeRecord('dir.example.com'), makeRecord('dir.ever.works')];
        const works = [makeWork({ id: '11111111-aaaa-bbbb-cccc-dddddddddddd', slug: 'dir' })];
        const cloudflare = makeLister(records, 'ever.works');
        const adapter = makeWorksAdapter(works);
        const svc = new BackfillManagedSubdomainService(adapter, cloudflare, silentLogger);

        const summary = await svc.run({ write: true });
        expect(summary.matched).toBe(1);
        expect(adapter.update).toHaveBeenCalledWith('11111111-aaaa-bbbb-cccc-dddddddddddd', {
            managedSubdomain: 'dir',
        });
    });

    it('ignores multi-label records (foo.bar.ever.works) — not a managed-subdomain shape', async () => {
        const records = [makeRecord('deep.subdomain.ever.works'), makeRecord('dir.ever.works')];
        const works = [
            makeWork({ id: '11111111-aaaa-bbbb-cccc-dddddddddddd', slug: 'subdomain' }),
            makeWork({ id: '22222222-aaaa-bbbb-cccc-dddddddddddd', slug: 'dir' }),
        ];
        const cloudflare = makeLister(records, 'ever.works');
        const adapter = makeWorksAdapter(works);
        const svc = new BackfillManagedSubdomainService(adapter, cloudflare, silentLogger);

        const summary = await svc.run({ write: true });
        // `subdomain` should not match `deep.subdomain.ever.works` (we only
        // consider single-label managed shapes), so noCandidate=1.
        expect(summary.noCandidate).toBe(1);
        expect(summary.matched).toBe(1);
        expect(adapter.update).toHaveBeenCalledWith('22222222-aaaa-bbbb-cccc-dddddddddddd', {
            managedSubdomain: 'dir',
        });
    });

    it('treats persistence failures as non-fatal — continues with the next work', async () => {
        const records = [makeRecord('dir.ever.works'), makeRecord('mcpserver.ever.works')];
        const works = [
            makeWork({ id: '11111111-aaaa-bbbb-cccc-dddddddddddd', slug: 'dir' }),
            makeWork({ id: '22222222-aaaa-bbbb-cccc-dddddddddddd', slug: 'mcpserver' }),
        ];
        const cloudflare = makeLister(records, 'ever.works');
        const adapter = makeWorksAdapter(works);
        adapter.update.mockImplementationOnce(async () => {
            throw new Error('boom');
        });
        const svc = new BackfillManagedSubdomainService(adapter, cloudflare, silentLogger);

        const summary = await svc.run({ write: true });

        expect(summary.matched).toBe(2);
        // First update threw, second succeeded — only one persisted.
        expect(summary.persisted).toBe(1);
        expect(silentLogger.error).toHaveBeenCalled();
    });
});

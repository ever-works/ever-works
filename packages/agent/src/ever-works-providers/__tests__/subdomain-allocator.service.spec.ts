import { SubdomainAllocator } from '../subdomain-allocator.service';
import type { WorkRepository } from '../../database/repositories/work.repository';
import type { EverWorksDnsService } from '../cloudflare-dns.provider';
import type { Work } from '../../entities/work.entity';
import type { IDnsOperations } from '@ever-works/plugin';

/**
 * EW-734 / EW-737 — `SubdomainAllocator` unit tests.
 *
 * Scope: the allocator's two responsibilities only — (a) collision-safe
 * label allocation against the DB + provider probe, and (b) idempotent
 * reuse of a previously-persisted `work.managedSubdomain`. DNS record
 * creation is the caller's job (`applyManagedSubdomain`) and is covered
 * by the deploy.service tests.
 */
describe('SubdomainAllocator', () => {
    function makeWork(overrides: Partial<Work> = {}): Work {
        return {
            id: '11111111-2222-3333-4444-555555555555',
            slug: 'ai-coding',
            managedSubdomain: null,
            ...overrides,
        } as Work;
    }

    function makeRepo(
        opts: {
            findByManagedSubdomainReturns?: (label: string) => Work | null;
            updateImpl?: (id: string, patch: Partial<Work>) => Promise<Work | null>;
        } = {},
    ) {
        const update = jest.fn(
            opts.updateImpl ?? (async (_id: string, _patch: Partial<Work>) => null),
        );
        const findByManagedSubdomain = jest.fn(async (label: string) =>
            opts.findByManagedSubdomainReturns ? opts.findByManagedSubdomainReturns(label) : null,
        );
        return {
            update,
            findByManagedSubdomain,
        } as unknown as WorkRepository & {
            update: jest.Mock;
            findByManagedSubdomain: jest.Mock;
        };
    }

    function makeDnsService(provider: IDnsOperations | null) {
        return {
            getProvider: () => provider,
        } as unknown as EverWorksDnsService;
    }

    function makeProbe(
        recordExistsImpl: (host: string) => Promise<boolean> | boolean,
    ): IDnsOperations {
        return {
            rootDomain: () => 'ever.works',
            recordExists: jest.fn(async (host: string) => recordExistsImpl(host)),
            ensureRecord: jest.fn(),
            removeRecord: jest.fn(),
        } as unknown as IDnsOperations;
    }

    it('reuses an already-persisted managedSubdomain (no DB write, no probe)', async () => {
        const repo = makeRepo();
        const probe = makeProbe(async () => {
            throw new Error('should not probe when reusing');
        });
        const dns = makeDnsService(probe);
        const alloc = new SubdomainAllocator(repo, dns);

        const work = makeWork({ managedSubdomain: 'already-claimed' });
        const result = await alloc.allocate(work, probe);

        expect(result).toEqual({
            subdomain: 'already-claimed',
            fqdn: 'already-claimed.ever.works',
            rootDomain: 'ever.works',
            allocated: false,
        });
        expect(repo.update).not.toHaveBeenCalled();
    });

    it('allocates the slug as-is when the label is free in DB + provider', async () => {
        const repo = makeRepo();
        const probe = makeProbe(async () => false);
        const dns = makeDnsService(probe);
        const alloc = new SubdomainAllocator(repo, dns);

        const work = makeWork({ slug: 'ai-coding' });
        const result = await alloc.allocate(work, probe);

        expect(result.subdomain).toBe('ai-coding');
        expect(result.fqdn).toBe('ai-coding.ever.works');
        expect(result.allocated).toBe(true);
        expect(repo.update).toHaveBeenCalledWith(work.id, { managedSubdomain: 'ai-coding' });
    });

    it('appends a deterministic shortId suffix on DB collision', async () => {
        const otherWork = { id: 'other-id', managedSubdomain: 'ai-coding' } as Work;
        const repo = makeRepo({
            findByManagedSubdomainReturns: (label) => (label === 'ai-coding' ? otherWork : null),
        });
        const probe = makeProbe(async () => false);
        const dns = makeDnsService(probe);
        const alloc = new SubdomainAllocator(repo, dns);

        const work = makeWork({ id: 'aabbccdd-1111-2222-3333-444444444444' });
        const result = await alloc.allocate(work, probe);

        // shortId = first 4 hex chars of UUID with dashes removed → 'aabb'
        expect(result.subdomain).toBe('ai-coding-aabb');
        expect(repo.update).toHaveBeenCalledWith(work.id, {
            managedSubdomain: 'ai-coding-aabb',
        });
    });

    it('rejects reserved blocklist labels (www) and falls through to the suffixed candidate', async () => {
        const repo = makeRepo();
        const probe = makeProbe(async () => false);
        const dns = makeDnsService(probe);
        const alloc = new SubdomainAllocator(repo, dns);

        const work = makeWork({ slug: 'www', id: 'cafebabe-0000-0000-0000-000000000000' });
        const result = await alloc.allocate(work, probe);

        // `www` is blocklisted as a base, so the suffixed candidate wins.
        expect(result.subdomain).toBe('www-cafe');
    });

    it('treats a provider-side recordExists collision as taken', async () => {
        const repo = makeRepo();
        const probe = makeProbe(async (host) => host === 'ai-coding.ever.works');
        const dns = makeDnsService(probe);
        const alloc = new SubdomainAllocator(repo, dns);

        const work = makeWork({ id: 'feedface-1111-2222-3333-444444444444' });
        const result = await alloc.allocate(work, probe);

        expect(result.subdomain).toBe('ai-coding-feed');
    });

    it('skips the provider probe gracefully when DNS service returns no provider', async () => {
        const repo = makeRepo();
        const dns = makeDnsService(null);
        const alloc = new SubdomainAllocator(repo, dns);

        const work = makeWork();
        const result = await alloc.allocate(work);

        expect(result.subdomain).toBe('ai-coding');
        expect(result.allocated).toBe(true);
    });

    it('retries on a DB partial-unique-index race (23505) and falls through to the suffixed candidate', async () => {
        // Simulates: two concurrent first-deploys for slug `ai-coding`. The
        // in-process DB probe says free, but `update()` raises a Postgres
        // 23505 unique violation because the other deploy won the race.
        let firstUpdate = true;
        const repo = makeRepo({
            updateImpl: async (id: string, patch: Partial<Work>) => {
                if (firstUpdate && patch.managedSubdomain === 'ai-coding') {
                    firstUpdate = false;
                    const err = new Error(
                        'duplicate key value violates unique constraint "UQ_works_managedSubdomain_notnull"',
                    ) as Error & { code?: string };
                    err.code = '23505';
                    throw err;
                }
                return null;
            },
        });
        const probe = makeProbe(async () => false);
        const dns = makeDnsService(probe);
        const alloc = new SubdomainAllocator(repo, dns);

        const work = makeWork({ id: 'deadbeef-1111-2222-3333-444444444444' });
        const result = await alloc.allocate(work, probe);

        expect(result.subdomain).toBe('ai-coding-dead');
        expect(repo.update).toHaveBeenCalledTimes(2);
    });

    it('rethrows non-unique-violation update errors', async () => {
        const repo = makeRepo({
            updateImpl: async () => {
                throw new Error('connection refused');
            },
        });
        const probe = makeProbe(async () => false);
        const dns = makeDnsService(probe);
        const alloc = new SubdomainAllocator(repo, dns);

        const work = makeWork();
        await expect(alloc.allocate(work, probe)).rejects.toThrow(/connection refused/);
    });

    it('throws when the slug is unusable', async () => {
        const repo = makeRepo();
        const probe = makeProbe(async () => false);
        const dns = makeDnsService(probe);
        const alloc = new SubdomainAllocator(repo, dns);

        const work = makeWork({ slug: '!!!' });
        await expect(alloc.allocate(work, probe)).rejects.toThrow(/no usable slug/);
    });
});

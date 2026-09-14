import type { ChangelogSourceEntry } from '@ever-works/contracts/api';
import type { ProductChangelogReadRepository, UserRepository } from '@ever-works/agent/database';
import type { ChangelogEntrySource } from './changelog-entry-source';
import { CHANGELOG_SOURCE_CACHE_TTL_MS, ChangelogService } from './changelog.service';

/**
 * What's new (AW-14) — `ChangelogService` against an in-memory read store and
 * a hand-built content source. Each case names the spec requirement it
 * pins. The read store mirrors the repository's contract (one row per
 * person + slug, idempotent writes) so idempotency is asserted on state, not
 * on call counts.
 */

const NOW = new Date('2026-09-14T12:00:00.000Z');
const USER = 'user-1';
const OTHER_USER = 'user-2';

function entry(
    slug: string,
    publishedAt: string,
    overrides: Partial<ChangelogSourceEntry> = {},
): ChangelogSourceEntry {
    return {
        slug,
        title: `Title for ${slug}`,
        body: `Body for ${slug}.`,
        category: 'agents',
        kind: 'new',
        publishedAt,
        ...overrides,
    };
}

function day(n: number): string {
    return new Date(Date.UTC(2026, 8, n, 9, 0, 0)).toISOString();
}

class InMemoryReads {
    readonly rows = new Map<string, Set<string>>();
    markReadCalls: string[][] = [];

    async findReadSlugs(userId: string, slugs: readonly string[]): Promise<Set<string>> {
        const mine = this.rows.get(userId) ?? new Set<string>();
        return new Set(slugs.filter((slug) => mine.has(slug)));
    }

    async markRead(userId: string, slugs: readonly string[]): Promise<void> {
        this.markReadCalls.push([...slugs]);
        const mine = this.rows.get(userId) ?? new Set<string>();
        slugs.forEach((slug) => mine.add(slug));
        this.rows.set(userId, mine);
    }

    async countUnread(userId: string, candidates: readonly string[]): Promise<number> {
        const read = await this.findReadSlugs(userId, candidates);
        return new Set(candidates).size - read.size;
    }

    rowCount(userId: string): number {
        return this.rows.get(userId)?.size ?? 0;
    }
}

function build(
    entries: readonly ChangelogSourceEntry[],
    accountCreatedAt: Date | null = new Date('2026-01-01T00:00:00.000Z'),
) {
    const reads = new InMemoryReads();
    const users = {
        findById: jest.fn(async (id: string) =>
            accountCreatedAt === null ? null : { id, createdAt: accountCreatedAt },
        ),
    };
    const source: ChangelogEntrySource & { load: jest.Mock } = {
        id: 'test',
        load: jest.fn(async () => entries),
    };
    const service = new ChangelogService(
        source,
        reads as unknown as ProductChangelogReadRepository,
        users as unknown as UserRepository,
    );
    return { service, reads, users, source };
}

describe('ChangelogService', () => {
    describe('visibility and ordering', () => {
        it('FR-7: excludes scheduled entries from the list, the count and slug lookup', async () => {
            const { service } = build([
                entry('published-one', day(10)),
                entry('scheduled-one', '2026-09-20T00:00:00.000Z'),
            ]);

            const list = await service.list(USER, {}, NOW);
            expect(list.entries.map((e) => e.slug)).toEqual(['published-one']);
            expect(list.total).toBe(1);
            expect(await service.unreadCount(USER, NOW)).toBe(1);
            expect(await service.getBySlug(USER, 'scheduled-one', NOW)).toBeNull();
        });

        it('FR-7: a scheduled entry appears on its date without a reload of the source', async () => {
            const { service, source } = build([entry('scheduled-one', '2026-09-14T12:01:00.000Z')]);

            expect((await service.list(USER, {}, NOW)).entries).toHaveLength(0);
            const later = new Date('2026-09-14T12:01:00.000Z');
            expect((await service.list(USER, {}, later)).entries.map((e) => e.slug)).toEqual([
                'scheduled-one',
            ]);
            expect(source.load).toHaveBeenCalledTimes(1);
        });

        it('FR-8: the pinned entry sorts first, the rest newest first', async () => {
            const { service } = build([
                entry('older-pinned', day(1), { pinned: true }),
                entry('newest', day(12)),
                entry('middle', day(6)),
            ]);

            const list = await service.list(USER, {}, NOW);
            expect(list.entries.map((e) => [e.slug, e.pinned])).toEqual([
                ['older-pinned', true],
                ['newest', false],
                ['middle', false],
            ]);
        });

        it('FR-8: ties on publishedAt are broken by slug ascending', async () => {
            const { service } = build([
                entry('bbb-entry', day(5)),
                entry('aaa-entry', day(5)),
                entry('ccc-entry', day(5)),
            ]);

            expect((await service.list(USER, {}, NOW)).entries.map((e) => e.slug)).toEqual([
                'aaa-entry',
                'bbb-entry',
                'ccc-entry',
            ]);
        });

        it('FR-27: only the newest 200 published entries are reachable', async () => {
            const many = Array.from({ length: 205 }, (_, i) =>
                entry(
                    `entry-${String(i).padStart(3, '0')}`,
                    new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
                ),
            );
            const { service } = build(many, new Date('2025-01-01T00:00:00.000Z'));

            const list = await service.list(USER, { limit: 50 }, NOW);
            expect(list.total).toBe(200);
            expect(await service.getBySlug(USER, 'entry-000', NOW)).toBeNull();
            expect(await service.getBySlug(USER, 'entry-204', NOW)).not.toBeNull();
        });

        it('FR-5: drops a malformed record and serves the rest', async () => {
            const { service } = build([
                entry('good-entry', day(3)),
                entry('bad-entry', day(4), { title: 'x'.repeat(81) }),
                entry('Bad Slug', day(5)),
            ]);

            expect((await service.list(USER, {}, NOW)).entries.map((e) => e.slug)).toEqual([
                'good-entry',
            ]);
        });

        it('FR-40: an unsafe call-to-action is removed while the entry still renders', async () => {
            const { service } = build([
                entry('safe-cta', day(3), { cta: { label: 'Open Inbox', href: '/inbox' } }),
                entry('unsafe-cta', day(4), { cta: { label: 'Go', href: '//evil.example' } }),
            ]);

            const list = await service.list(USER, {}, NOW);
            expect(list.entries.find((e) => e.slug === 'safe-cta')?.cta).toEqual({
                label: 'Open Inbox',
                href: '/inbox',
            });
            expect(list.entries.find((e) => e.slug === 'unsafe-cta')?.cta).toBeNull();
        });
    });

    describe('paging and filtering', () => {
        const twelve = Array.from({ length: 12 }, (_, i) =>
            entry(`entry-${String(i).padStart(2, '0')}`, day(i + 1), {
                category: i % 3 === 0 ? 'costs' : 'agents',
            }),
        );

        it('cursor paging returns disjoint pages and a null nextCursor on the last page', async () => {
            const { service } = build(twelve);

            const first = await service.list(USER, { limit: 5 }, NOW);
            const second = await service.list(USER, { limit: 5, cursor: first.nextCursor! }, NOW);
            const third = await service.list(USER, { limit: 5, cursor: second.nextCursor! }, NOW);

            const slugs = [...first.entries, ...second.entries, ...third.entries].map(
                (e) => e.slug,
            );
            expect(new Set(slugs).size).toBe(12);
            expect(first.nextCursor).toBe(first.entries[4].slug);
            expect(third.entries).toHaveLength(2);
            expect(third.nextCursor).toBeNull();
        });

        it('an exactly-full last page has a null nextCursor', async () => {
            const { service } = build(twelve.slice(0, 5));

            expect((await service.list(USER, { limit: 5 }, NOW)).nextCursor).toBeNull();
        });

        it('an unknown cursor yields an empty page rather than duplicates', async () => {
            const { service } = build(twelve);

            const page = await service.list(USER, { limit: 5, cursor: 'no-such-entry' }, NOW);
            expect(page.entries).toEqual([]);
            expect(page.nextCursor).toBeNull();
        });

        it('limit defaults to 20 and clamps to 1..50', async () => {
            const sixty = Array.from({ length: 60 }, (_, i) =>
                entry(`entry-${String(i).padStart(2, '0')}`, day(1)),
            );
            const { service } = build(sixty);

            expect((await service.list(USER, {}, NOW)).entries).toHaveLength(20);
            expect((await service.list(USER, { limit: 500 }, NOW)).entries).toHaveLength(50);
            expect((await service.list(USER, { limit: 0 }, NOW)).entries).toHaveLength(1);
            expect((await service.list(USER, { limit: -7 }, NOW)).entries).toHaveLength(1);
        });

        it('FR-38: a category filter narrows the entries but never the unread count', async () => {
            const { service } = build(twelve);

            const all = await service.list(USER, {}, NOW);
            const costs = await service.list(USER, { category: 'costs' }, NOW);

            expect(costs.entries.every((e) => e.category === 'costs')).toBe(true);
            expect(costs.entries).toHaveLength(4);
            expect(costs.unreadCount).toBe(all.unreadCount);
            expect(costs.unreadCount).toBe(12);
            expect(costs.total).toBe(12);
        });

        it('FR-37: categoriesWithEntries lists only categories with a visible entry, in canonical order', async () => {
            const { service } = build([
                entry('costs-entry', day(2), { category: 'costs' }),
                entry('agents-entry', day(3), { category: 'agents' }),
                entry('knowledge-scheduled', '2026-10-01T00:00:00.000Z', { category: 'knowledge' }),
            ]);

            expect((await service.list(USER, {}, NOW)).categoriesWithEntries).toEqual([
                'agents',
                'costs',
            ]);
        });

        it('S-13: an empty catalogue returns an empty, well-formed response', async () => {
            const { service } = build([]);

            expect(await service.list(USER, {}, NOW)).toEqual({
                entries: [],
                nextCursor: null,
                total: 0,
                unreadCount: 0,
                categoriesWithEntries: [],
            });
            expect(await service.unreadCount(USER, NOW)).toBe(0);
        });
    });

    describe('read state and the unread count', () => {
        it('FR-14: entries older than the account are read with zero rows written', async () => {
            const accountCreatedAt = new Date(day(5));
            const { service, reads } = build(
                [entry('before-signup', day(2)), entry('after-signup', day(8))],
                accountCreatedAt,
            );

            const list = await service.list(USER, {}, NOW);
            expect(list.entries.find((e) => e.slug === 'before-signup')?.isRead).toBe(true);
            expect(list.entries.find((e) => e.slug === 'after-signup')?.isRead).toBe(false);
            expect(list.unreadCount).toBe(1);
            expect(reads.rowCount(USER)).toBe(0);
        });

        it('S-7: a brand-new account on a deployment full of entries starts at zero', async () => {
            const history = Array.from({ length: 30 }, (_, i) =>
                entry(`old-${String(i).padStart(2, '0')}`, day(1)),
            );
            const { service } = build(history, NOW);

            expect(await service.unreadCount(USER, NOW)).toBe(0);
        });

        it('FR-14: an unknown user counts nothing as unread rather than everything', async () => {
            const { service } = build([entry('any-entry', day(3))], null);

            expect(await service.unreadCount(USER, NOW)).toBe(0);
        });

        it('FR-15: unread is computed over at most the newest 50 published entries', async () => {
            const sixty = Array.from({ length: 60 }, (_, i) =>
                entry(
                    `entry-${String(i).padStart(2, '0')}`,
                    new Date(Date.UTC(2026, 7, 1) + i * 3_600_000).toISOString(),
                ),
            );
            const { service } = build(sixty);

            expect(await service.unreadCount(USER, NOW)).toBe(50);
        });

        it('FR-15: reading an entry outside the newest 50 does not change the count', async () => {
            const sixty = Array.from({ length: 60 }, (_, i) =>
                entry(
                    `entry-${String(i).padStart(2, '0')}`,
                    new Date(Date.UTC(2026, 7, 1) + i * 3_600_000).toISOString(),
                ),
            );
            const { service } = build(sixty);

            const result = await service.markRead(USER, ['entry-00'], NOW);
            expect(result.unreadCount).toBe(50);
        });

        it('markRead returns the fresh count and flips isRead on the list', async () => {
            const { service } = build([
                entry('first-entry', day(3)),
                entry('second-entry', day(4)),
            ]);

            expect(await service.markRead(USER, ['second-entry'], NOW)).toEqual({ unreadCount: 1 });
            const list = await service.list(USER, {}, NOW);
            expect(list.entries.find((e) => e.slug === 'second-entry')?.isRead).toBe(true);
            expect((await service.getBySlug(USER, 'second-entry', NOW))?.isRead).toBe(true);
        });

        it('FR-12: read state belongs to the person — another reader is unaffected', async () => {
            const { service } = build([entry('first-entry', day(3))]);

            await service.markRead(USER, ['first-entry'], NOW);
            expect(await service.unreadCount(USER, NOW)).toBe(0);
            expect(await service.unreadCount(OTHER_USER, NOW)).toBe(1);
        });

        it('ignores unknown and scheduled slugs in markRead', async () => {
            const { service, reads } = build([
                entry('first-entry', day(3)),
                entry('scheduled-one', '2026-12-01T00:00:00.000Z'),
            ]);

            const result = await service.markRead(
                USER,
                ['first-entry', 'no-such-entry', 'scheduled-one'],
                NOW,
            );
            expect(result).toEqual({ unreadCount: 0 });
            expect([...(reads.rows.get(USER) ?? [])]).toEqual(['first-entry']);
        });

        it('writes no row for an entry the signup baseline already counts as read', async () => {
            const { service, reads } = build([entry('before-signup', day(2))], new Date(day(5)));

            await service.markRead(USER, ['before-signup'], NOW);
            expect(reads.rowCount(USER)).toBe(0);
        });

        it('FR-18: markRead twice is a no-op the second time', async () => {
            const { service, reads } = build([
                entry('first-entry', day(3)),
                entry('second-entry', day(4)),
            ]);

            const once = await service.markRead(USER, ['first-entry'], NOW);
            const twice = await service.markRead(USER, ['first-entry'], NOW);
            expect(twice).toEqual(once);
            expect(reads.rowCount(USER)).toBe(1);
        });

        it('FR-19: markAllRead clears every visible entry and returns zero', async () => {
            const { service, reads } = build([
                entry('agents-one', day(3), { category: 'agents' }),
                entry('costs-one', day(4), { category: 'costs' }),
                entry('scheduled-one', '2026-12-01T00:00:00.000Z'),
            ]);

            expect(await service.markAllRead(USER, NOW)).toEqual({ unreadCount: 0 });
            expect(await service.unreadCount(USER, NOW)).toBe(0);
            expect([...(reads.rows.get(USER) ?? [])].sort()).toEqual(['agents-one', 'costs-one']);
        });

        it('FR-19: markAllRead twice is a no-op the second time', async () => {
            const { service, reads } = build([
                entry('first-entry', day(3)),
                entry('second-entry', day(4)),
            ]);

            await service.markAllRead(USER, NOW);
            await service.markAllRead(USER, NOW);
            expect(reads.rowCount(USER)).toBe(2);
            expect(await service.unreadCount(USER, NOW)).toBe(0);
        });

        it('FR-19: markAllRead ignores the category filter a client has on screen', async () => {
            const { service } = build([
                entry('agents-one', day(3), { category: 'agents' }),
                entry('costs-one', day(4), { category: 'costs' }),
            ]);

            // The client was looking at `costs` only; the write still covers everything.
            await service.list(USER, { category: 'costs' }, NOW);
            await service.markAllRead(USER, NOW);
            const agents = await service.list(USER, { category: 'agents' }, NOW);
            expect(agents.entries.every((e) => e.isRead)).toBe(true);
        });
    });

    describe('the content source', () => {
        it('FR-31: reuses a loaded source for at most 300 s', async () => {
            const { service, source } = build([entry('first-entry', day(3))]);

            await service.unreadCount(USER, NOW);
            await service.unreadCount(
                USER,
                new Date(NOW.getTime() + CHANGELOG_SOURCE_CACHE_TTL_MS - 1),
            );
            expect(source.load).toHaveBeenCalledTimes(1);

            await service.unreadCount(
                USER,
                new Date(NOW.getTime() + CHANGELOG_SOURCE_CACHE_TTL_MS),
            );
            expect(source.load).toHaveBeenCalledTimes(2);
        });

        it('shares one in-flight load between concurrent requests', async () => {
            const { service, source } = build([entry('first-entry', day(3))]);

            await Promise.all([
                service.unreadCount(USER, NOW),
                service.list(USER, {}, NOW),
                service.unreadCount(OTHER_USER, NOW),
            ]);
            expect(source.load).toHaveBeenCalledTimes(1);
        });

        it('keeps serving the last good entries when a reload fails', async () => {
            const { service, source } = build([entry('first-entry', day(3))]);

            await service.list(USER, {}, NOW);
            source.load.mockRejectedValueOnce(new Error('source unavailable'));
            const later = new Date(NOW.getTime() + CHANGELOG_SOURCE_CACHE_TTL_MS + 1);

            expect((await service.list(USER, {}, later)).entries.map((e) => e.slug)).toEqual([
                'first-entry',
            ]);
        });

        it('S-10: propagates a failure when no entries were ever loaded, never an empty list', async () => {
            const { service, source } = build([entry('first-entry', day(3))]);
            source.load.mockRejectedValueOnce(new Error('source unavailable'));

            await expect(service.list(USER, {}, NOW)).rejects.toThrow('source unavailable');
            // …and recovers on the next request.
            expect((await service.list(USER, {}, NOW)).entries).toHaveLength(1);
        });

        it('any ChangelogEntrySource can be bound — the service never reads the entries file directly', async () => {
            const { service } = build([
                entry('from-another-source', day(3), { category: 'platform' }),
            ]);

            const list = await service.list(USER, {}, NOW);
            expect(list.entries.map((e) => e.slug)).toEqual(['from-another-source']);
            expect(list.categoriesWithEntries).toEqual(['platform']);
        });
    });
});

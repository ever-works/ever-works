import { DataSource, Repository } from 'typeorm';
import { ProductChangelogRead } from '@src/entities/product-changelog-read.entity';
import { ProductChangelogReadRepository } from './product-changelog-read.repository';

/**
 * What's new (AW-14) — read state executed against a real in-memory sqlite
 * table, so the unique `(userId, entrySlug)` index and `orIgnore()` are
 * exercised for real rather than mocked. The two properties that matter:
 *
 *  - marking read is idempotent, including two concurrent writers for the
 *    same (person, entry) — exactly one row, no error (spec FR-18, S-17);
 *  - read state is per person — one person's reads never count for
 *    another (spec FR-12).
 */
describe('ProductChangelogReadRepository (integration)', () => {
    let dataSource: DataSource;
    let rows: Repository<ProductChangelogRead>;
    let repository: ProductChangelogReadRepository;

    const ALICE = '11111111-1111-4111-8111-111111111111';
    const BOB = '22222222-2222-4222-8222-222222222222';

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [ProductChangelogRead],
            synchronize: true,
        });
        await dataSource.initialize();
        rows = dataSource.getRepository(ProductChangelogRead);
        repository = new ProductChangelogReadRepository(rows);
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await rows.clear();
    });

    it('records each slug once, even when the same slug appears twice in one call', async () => {
        await repository.markRead(ALICE, ['one-entry', 'two-entry', 'one-entry']);

        expect(await rows.count({ where: { userId: ALICE } })).toBe(2);
    });

    it('is idempotent across calls — marking the same entry again changes nothing (FR-18)', async () => {
        await repository.markRead(ALICE, ['one-entry']);
        await repository.markRead(ALICE, ['one-entry']);

        expect(await rows.count()).toBe(1);
    });

    it('leaves exactly one row when two writers mark the same entry at once (S-17)', async () => {
        await Promise.all([
            repository.markRead(ALICE, ['one-entry', 'two-entry']),
            repository.markRead(ALICE, ['two-entry', 'one-entry']),
        ]);

        expect(await rows.count()).toBe(2);
    });

    it('treats an empty write as a no-op', async () => {
        await expect(repository.markRead(ALICE, [])).resolves.toBeUndefined();
        expect(await rows.count()).toBe(0);
    });

    it('finds only the slugs this person has read', async () => {
        await repository.markRead(ALICE, ['one-entry']);
        await repository.markRead(BOB, ['two-entry']);

        const found = await repository.findReadSlugs(ALICE, [
            'one-entry',
            'two-entry',
            'three-entry',
        ]);

        expect([...found]).toEqual(['one-entry']);
        expect(await repository.findReadSlugs(ALICE, [])).toEqual(new Set());
    });

    it('counts unread candidates per person, never across people (FR-12, FR-15)', async () => {
        await repository.markRead(ALICE, ['one-entry']);
        await repository.markRead(BOB, ['one-entry', 'two-entry']);

        expect(await repository.countUnread(ALICE, ['one-entry', 'two-entry', 'three-entry'])).toBe(
            2,
        );
        expect(await repository.countUnread(BOB, ['one-entry', 'two-entry', 'three-entry'])).toBe(
            1,
        );
        expect(await repository.countUnread(ALICE, [])).toBe(0);
    });

    it('ignores read rows for slugs outside the candidate list when counting (FR-22)', async () => {
        await repository.markRead(ALICE, ['removed-from-build', 'one-entry']);

        expect(await repository.countUnread(ALICE, ['one-entry', 'two-entry'])).toBe(1);
    });

    it('prunes only old rows whose slug the build no longer ships (FR-22)', async () => {
        await repository.markRead(ALICE, ['still-shipped', 'removed-old', 'removed-recent']);
        const longAgo = new Date(Date.UTC(2026, 0, 1));
        await rows.update({ entrySlug: 'removed-old' }, { readAt: longAgo });
        await rows.update({ entrySlug: 'still-shipped' }, { readAt: longAgo });

        const removed = await repository.deleteBySlugsNotIn(
            ['still-shipped'],
            new Date(Date.UTC(2026, 5, 1)),
        );

        expect(removed).toBe(1);
        const remaining = (await rows.find()).map((row) => row.entrySlug).sort();
        expect(remaining).toEqual(['removed-recent', 'still-shipped']);
    });

    it('refuses to prune with an empty shipped-slug list rather than deleting everything', async () => {
        await repository.markRead(ALICE, ['one-entry']);
        await rows.update({ entrySlug: 'one-entry' }, { readAt: new Date(Date.UTC(2020, 0, 1)) });

        expect(await repository.deleteBySlugsNotIn([], new Date())).toBe(0);
        expect(await rows.count()).toBe(1);
    });
});

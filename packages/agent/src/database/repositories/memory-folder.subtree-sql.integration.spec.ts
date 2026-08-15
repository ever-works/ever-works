import { DataSource, Repository } from 'typeorm';
import { MemoryFolder } from '../../entities/memory-folder.entity';
import { MemoryFolderRepository } from './memory-folder.repository';

/**
 * The `memory_folders` materialized-path tree, executed against a REAL
 * SQL engine (better-sqlite3) rather than a mocked query builder.
 *
 * `listSubtree` and `updateSubtreePaths` are the two statements every
 * destructive folder operation is built on — recursive delete resolves
 * its victim set through the first, rename/move rewrites descendants
 * through the second. Both take a user-controlled string (the folder
 * path, i.e. folder NAMES) straight into the predicate, and all three
 * defects below are invisible to a mock: they only exist once the
 * database interprets the SQL.
 *
 *  1. `LIKE '<path>/%'` treats `%` and `_` in a folder name as wildcards,
 *     so `/Q1_2026` claimed `/Q1x2026/...` as its own subtree.
 *  2. TypeORM expands `:name` placeholders across the entire statement
 *     text, so a `newPath` inlined as a SQL literal let a folder named
 *     `:userId` rewrite the statement's parameter list.
 *  3. SQL `substr` counts characters while JS `.length` counts UTF-16
 *     units, so one astral character (emoji) in an ancestor name shifted
 *     every descendant path by one character.
 */
describe('MemoryFolderRepository subtree SQL (integration)', () => {
    let dataSource: DataSource;
    let repo: Repository<MemoryFolder>;
    let repository: MemoryFolderRepository;

    const USER = 'user-1';
    const OTHER_USER = 'user-2';

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [MemoryFolder],
            synchronize: true,
        });
        await dataSource.initialize();
        repo = dataSource.getRepository(MemoryFolder);
        repository = new MemoryFolderRepository(repo);
    });

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    const make = (userId: string, path: string) =>
        repository.create({
            userId,
            name: path.slice(path.lastIndexOf('/') + 1),
            path,
            parentId: null,
        });

    const pathsOf = (folders: MemoryFolder[]) => folders.map((f) => f.path).sort();
    const allPaths = async (userId: string) =>
        (await repository.listByUser(userId)).map((f) => f.path).sort();

    describe('listSubtree', () => {
        it('does not treat `_` in a folder name as a wildcard', async () => {
            await make(USER, '/Q1_2026');
            await make(USER, '/Q1x2026');
            await make(USER, '/Q1x2026/Receipts');

            const subtree = await repository.listSubtree(USER, '/Q1_2026');

            // The `_` folder is empty: only itself comes back. With a LIKE
            // predicate `/Q1x2026/Receipts` matched too, and a recursive
            // delete of the empty folder dropped the neighbour's subtree.
            expect(pathsOf(subtree)).toEqual(['/Q1_2026']);
        });

        it('does not treat `%` in a folder name as a wildcard', async () => {
            await make(USER, '/100%');
            await make(USER, '/100 percent');
            await make(USER, '/100 percent/Notes');

            const subtree = await repository.listSubtree(USER, '/100%');

            expect(pathsOf(subtree)).toEqual(['/100%']);
        });

        it('still returns the real descendants of a folder', async () => {
            await make(USER, '/Docs');
            await make(USER, '/Docs/Q3');
            await make(USER, '/Docs/Q3/Receipts');
            await make(USER, '/Docsy');
            await make(OTHER_USER, '/Docs/Q3');

            const subtree = await repository.listSubtree(USER, '/Docs');

            // `/Docsy` is a different folder, not a descendant — the
            // separator in the prefix is what keeps it out. The other
            // user's identical path never appears.
            expect(pathsOf(subtree)).toEqual(['/Docs', '/Docs/Q3', '/Docs/Q3/Receipts']);
        });
    });

    describe('updateSubtreePaths', () => {
        it('rewrites the folder and its descendants only', async () => {
            await make(USER, '/Docs');
            await make(USER, '/Docs/Q3');
            await make(USER, '/Docsy');

            await repository.updateSubtreePaths(USER, '/Docs', '/Notes');

            expect(await allPaths(USER)).toEqual(['/Docsy', '/Notes', '/Notes/Q3']);
        });

        it('leaves a wildcard-lookalike sibling subtree untouched', async () => {
            await make(USER, '/Q1_2026');
            await make(USER, '/Q1x2026');
            await make(USER, '/Q1x2026/Receipts');

            await repository.updateSubtreePaths(USER, '/Q1_2026', '/Q1 2026');

            expect(await allPaths(USER)).toEqual(['/Q1 2026', '/Q1x2026', '/Q1x2026/Receipts']);
        });

        it('handles a folder name that looks like a bound parameter', async () => {
            await make(USER, '/:userId');
            await make(USER, '/:userId/Child');

            await repository.updateSubtreePaths(USER, '/:userId', '/:oldPath');

            expect(await allPaths(USER)).toEqual(['/:oldPath', '/:oldPath/Child']);
        });

        it('keeps descendant paths intact when an ancestor name holds an emoji', async () => {
            // '📁' is one SQL character but two JS UTF-16 units.
            await make(USER, '/📁Docs');
            await make(USER, '/📁Docs/Q3');

            await repository.updateSubtreePaths(USER, '/📁Docs', '/Plain');

            expect(await allPaths(USER)).toEqual(['/Plain', '/Plain/Q3']);
        });

        it('never touches another user’s identically named tree', async () => {
            await make(USER, '/Docs');
            await make(OTHER_USER, '/Docs');
            await make(OTHER_USER, '/Docs/Q3');

            await repository.updateSubtreePaths(USER, '/Docs', '/Notes');

            expect(await allPaths(USER)).toEqual(['/Notes']);
            expect(await allPaths(OTHER_USER)).toEqual(['/Docs', '/Docs/Q3']);
        });
    });
});

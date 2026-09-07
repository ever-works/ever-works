import { DataSource } from 'typeorm';
import { ENTITIES } from '../_entities-inventory';
import { GitHubAppInstallationRepository as GitHubAppInstallationRepositoryEntity } from '../../entities/github-app-installation-repository.entity';
import { GitHubAppInstallationRepoRepository } from './github-app-installation-repository.repository';

describe('GitHubAppInstallationRepoRepository', () => {
    let repository: {
        manager: {
            transaction: jest.Mock;
        };
    };
    let transactionalRepository: {
        delete: jest.Mock;
        create: jest.Mock;
        save: jest.Mock;
    };
    let installationRepoRepository: GitHubAppInstallationRepoRepository;

    beforeEach(() => {
        transactionalRepository = {
            delete: jest.fn(),
            create: jest.fn((value) => value),
            save: jest.fn(),
        };
        repository = {
            manager: {
                transaction: jest.fn(async (callback) =>
                    callback({
                        getRepository: jest.fn().mockReturnValue(transactionalRepository),
                    }),
                ),
            },
        };

        installationRepoRepository = new GitHubAppInstallationRepoRepository(repository as any);
    });

    it('replaces installation repositories inside a transaction', async () => {
        transactionalRepository.save.mockResolvedValue([{ id: 'repo-row-1' }]);

        const result = await installationRepoRepository.replaceForInstallation('installation-1', [
            {
                githubRepoId: '123',
                owner: 'ever-works',
                repo: 'awesome-list',
                fullName: 'ever-works/awesome-list',
                isPrivate: false,
                defaultBranch: 'main',
            },
        ]);

        expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
        expect(transactionalRepository.delete).toHaveBeenCalledWith({
            installationEntityId: 'installation-1',
        });
        expect(transactionalRepository.save).toHaveBeenCalledWith([
            expect.objectContaining({
                installationEntityId: 'installation-1',
                githubRepoId: '123',
            }),
        ]);
        expect(result).toEqual([{ id: 'repo-row-1' }]);
    });

    it('returns an empty array after deleting rows when no repositories remain', async () => {
        const result = await installationRepoRepository.replaceForInstallation(
            'installation-1',
            [],
        );

        expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
        expect(transactionalRepository.delete).toHaveBeenCalledWith({
            installationEntityId: 'installation-1',
        });
        expect(transactionalRepository.save).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });
});

/**
 * REGRESSION — `findByFullName` could never see a mixed-case repository
 * (self-build slice AM review, EW-810, F6).
 *
 * `fullName` is written verbatim from GitHub's `full_name`, so the column
 * holds whatever casing a repository declares. The fleet's scoped push
 * credential lower-cases the repositories it wants (GitHub names ARE
 * case-insensitive) before asking, so the old exact `where: { fullName }` —
 * case-SENSITIVE on Postgres — returned zero rows for
 * `Ever-Works/Directory-Web-Template`. The scope then came back
 * `push-scope-unresolved` and the planner refused the Task at plan time,
 * indistinguishably from a repository no installation covers. An entire
 * class of repositories silently lost fleet execution even though the
 * installation covered them.
 *
 * A real in-memory DataSource rather than the mocked repository the cases
 * above use: the defect is what the DATABASE does with the comparison, and
 * an assertion on the emitted SQL string would have passed against the
 * broken version too.
 */
describe('GitHubAppInstallationRepoRepository.findByFullName (real DataSource)', () => {
    let dataSource: DataSource;
    let repository: GitHubAppInstallationRepoRepository;

    const INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';
    const OTHER_INSTALLATION_ID = '22222222-2222-4222-8222-222222222222';

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();

        const rows = dataSource.getRepository(GitHubAppInstallationRepositoryEntity);
        repository = new GitHubAppInstallationRepoRepository(rows);
        await rows.save([
            rows.create({
                installationEntityId: INSTALLATION_ID,
                githubRepoId: '901',
                owner: 'Ever-Works',
                repo: 'Directory-Web-Template',
                // Exactly how GitHub reports it, which is exactly how
                // `GitHubAppSyncService` stores it.
                fullName: 'Ever-Works/Directory-Web-Template',
                isPrivate: true,
            } as Partial<GitHubAppInstallationRepositoryEntity>),
            rows.create({
                installationEntityId: INSTALLATION_ID,
                githubRepoId: '902',
                owner: 'ever-works',
                repo: 'ever-works',
                fullName: 'ever-works/ever-works',
                isPrivate: true,
            } as Partial<GitHubAppInstallationRepositoryEntity>),
            rows.create({
                installationEntityId: OTHER_INSTALLATION_ID,
                githubRepoId: '903',
                owner: 'someone-else',
                repo: 'private-repo',
                fullName: 'someone-else/private-repo',
                isPrivate: true,
            } as Partial<GitHubAppInstallationRepositoryEntity>),
        ]);
    });

    afterAll(async () => {
        await dataSource?.destroy();
    });

    it('finds a mixed-case repository by its lower-cased name', async () => {
        // The exact query the push-credential scope resolver issues.
        const found = await repository.findByFullName('ever-works/directory-web-template');

        expect(found.map((row) => row.githubRepoId)).toEqual(['901']);
        // The row still carries GitHub's own casing — the MATCH is
        // case-insensitive, the STORED value is untouched, so the caller's
        // own re-check against its normalized name still means something.
        expect(found[0].fullName).toBe('Ever-Works/Directory-Web-Template');
    });

    it('finds it from any casing the caller happens to use', async () => {
        for (const query of [
            'Ever-Works/Directory-Web-Template',
            'EVER-WORKS/DIRECTORY-WEB-TEMPLATE',
            'eVeR-wOrKs/dIrEcToRy-WeB-tEmPlAtE',
        ]) {
            const found = await repository.findByFullName(query);
            expect(found.map((row) => row.githubRepoId)).toEqual(['901']);
        }
    });

    it('still matches an all-lower-case row exactly as before', async () => {
        const found = await repository.findByFullName('ever-works/ever-works');
        expect(found.map((row) => row.githubRepoId)).toEqual(['902']);
    });

    it('does NOT widen the match to a different repository', async () => {
        // Case-insensitivity is the only thing that loosened. A name that is
        // not this repository — including one that merely shares the owner or
        // the repo half — still finds nothing, which is what keeps the scope
        // resolver's ownership filter meaningful.
        for (const query of [
            'ever-works/directory-web-templates',
            'ever-works/directory-web-templat',
            'other/directory-web-template',
            'directory-web-template',
            '',
        ]) {
            await expect(repository.findByFullName(query)).resolves.toEqual([]);
        }
    });

    it('returns EVERY installation that holds the repository, not just one', async () => {
        // The scope resolver refuses a run that two installations both cover
        // rather than picking by listing order, so it has to be able to see
        // both.
        const rows = dataSource.getRepository(GitHubAppInstallationRepositoryEntity);
        await rows.save(
            rows.create({
                installationEntityId: OTHER_INSTALLATION_ID,
                githubRepoId: '904',
                owner: 'Ever-Works',
                repo: 'Directory-Web-Template',
                fullName: 'ever-works/DIRECTORY-web-template',
                isPrivate: true,
            } as Partial<GitHubAppInstallationRepositoryEntity>),
        );

        const found = await repository.findByFullName('ever-works/directory-web-template');

        expect(found.map((row) => row.githubRepoId).sort()).toEqual(['901', '904']);
    });
});

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { GitFacadeService } from '../../facades/git.facade';
import { Work } from '../../entities/work.entity';
import { User } from '../../entities/user.entity';
import { PipelineOrchestratorService } from '../../pipeline';
import { WorkOperationsService } from '../../work-operations';
import { CategoryIconService } from '../../services/category-icon';
import { WorksConfigWriterService } from '../../works-config/services/works-config-writer.service';
import { DataGeneratorService } from './data-generator.service';
import type { DataRepository } from './data-repository';
import { DATA_REPO_RELEASE_WORKFLOW_PATH } from './release-workflow';

type EnsureOutcome = Awaited<ReturnType<DataRepository['ensureReleaseWorkflow']>>;

/**
 * EW-58 — the release workflow is seeded as a separate, best-effort commit
 * AFTER the data push has already succeeded. These tests pin the two
 * properties that matter: it commits exactly one file, and it can never turn a
 * successful generation into a failed one.
 */
describe('DataGeneratorService release-workflow seeding (EW-58)', () => {
    let service: DataGeneratorService;
    let gitFacade: {
        add: jest.Mock;
        addAll: jest.Mock;
        commit: jest.Mock;
        push: jest.Mock;
    };

    const user = { id: 'user-1' } as User;
    const work = {
        id: 'work-1',
        slug: 'awesome-vector-databases',
        gitProvider: 'github',
        getRepoOwner: () => 'ever-works',
        resolveCommitter: () => ({ name: 'Test User', email: 'test@example.com' }),
    } as unknown as Work;

    const makeData = (outcome: EnsureOutcome | Error) =>
        ({
            dir: 'C:/tmp/awesome-vector-databases-data',
            ensureReleaseWorkflow: jest
                .fn()
                .mockImplementation(() =>
                    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
                ),
        }) as unknown as DataRepository & { ensureReleaseWorkflow: jest.Mock };

    const seed = (data: DataRepository) =>
        (
            service as unknown as {
                seedReleaseWorkflow: (params: {
                    work: Work;
                    user: User;
                    data: DataRepository;
                    provider: string;
                    pushDir: string;
                    pushUserId: string;
                }) => Promise<void>;
            }
        ).seedReleaseWorkflow({
            work,
            user,
            data,
            provider: 'github',
            pushDir: 'C:/tmp/awesome-vector-databases-data',
            pushUserId: user.id,
        });

    beforeEach(async () => {
        gitFacade = {
            add: jest.fn().mockResolvedValue(undefined),
            addAll: jest.fn().mockResolvedValue(undefined),
            commit: jest.fn().mockResolvedValue(undefined),
            push: jest.fn().mockResolvedValue(undefined),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DataGeneratorService,
                { provide: GitFacadeService, useValue: gitFacade },
                { provide: PipelineOrchestratorService, useValue: {} },
                { provide: WorkOperationsService, useValue: {} },
                { provide: WorksConfigWriterService, useValue: {} },
                { provide: CategoryIconService, useValue: {} },
            ],
        }).compile();

        service = module.get(DataGeneratorService);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('commits and pushes only the workflow file when it was created', async () => {
        await seed(makeData('created'));

        expect(gitFacade.add).toHaveBeenCalledWith(
            'github',
            'C:/tmp/awesome-vector-databases-data',
            DATA_REPO_RELEASE_WORKFLOW_PATH,
        );
        // `addAll` would sweep unrelated working-tree files into the commit.
        expect(gitFacade.addAll).not.toHaveBeenCalled();
        expect(gitFacade.commit).toHaveBeenCalledWith(
            'github',
            'C:/tmp/awesome-vector-databases-data',
            'add automated release workflow',
            { name: 'Test User', email: 'test@example.com' },
        );
        expect(gitFacade.push).toHaveBeenCalledWith(
            { dir: 'C:/tmp/awesome-vector-databases-data' },
            { userId: 'user-1', providerId: 'github', workId: 'work-1' },
        );
    });

    it('uses an update commit message when an older revision was upgraded', async () => {
        await seed(makeData('updated'));

        expect(gitFacade.commit).toHaveBeenCalledWith(
            'github',
            expect.any(String),
            'update automated release workflow',
            expect.anything(),
        );
    });

    it.each<EnsureOutcome>(['unchanged', 'skipped'])(
        'does not touch git when the outcome is %s',
        async (outcome) => {
            await seed(makeData(outcome));

            expect(gitFacade.add).not.toHaveBeenCalled();
            expect(gitFacade.commit).not.toHaveBeenCalled();
            expect(gitFacade.push).not.toHaveBeenCalled();
        },
    );

    it('never fails the generation when the workflow file cannot be written', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

        await expect(seed(makeData(new Error('EACCES')))).resolves.toBeUndefined();

        expect(gitFacade.push).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
    });

    it('never fails the generation when the push is rejected for missing scope', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        gitFacade.push.mockRejectedValue(
            new Error('refusing to allow an OAuth App to create or update workflow'),
        );

        await expect(seed(makeData('created'))).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('workflow'));
    });
});

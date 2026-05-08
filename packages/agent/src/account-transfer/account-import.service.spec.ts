// Mock data-repository module so we don't pull in fs-extra/isomorphic-git
// at unit-test time. The service only uses static `DataRepository.create`.
jest.mock('../generators/data-generator/data-repository', () => ({
    DataRepository: { create: jest.fn() },
}));

import { AccountImportService } from './account-import.service';
import { DataRepository } from '../generators/data-generator/data-repository';
import { MASKED_SECRET_PREFIX } from './types';
import type { AccountExportPayload, ConflictResolution, ExportedWork } from './types';

const dataRepoCreateMock = DataRepository.create as jest.Mock;

/**
 * Pins the `AccountImportService` contract — the inverse of
 * `AccountExportService`. It is the most important security boundary on
 * the import side: masked-secret values from a round-tripped export MUST
 * never overwrite real credentials in the DB; instead a per-plugin warning
 * is emitted and the secretSettings field is left empty.
 *
 * The service also owns conflict resolution (`skip`/`overwrite`/`rename`),
 * the slug-uniqueness check on rename, and a single `dataSource`
 * transaction wrapping the whole import — a transaction failure rolls back
 * EVERY work import, but per-work errors inside the loop are caught and
 * pushed to `result.errors` without aborting the rest.
 */
describe('AccountImportService', () => {
    function makeData(overrides: Record<string, jest.Mock> = {}) {
        return {
            ensureWorksExist: jest.fn().mockResolvedValue(undefined),
            writeConfig: jest.fn().mockResolvedValue(undefined),
            writeMarkdownTemplate: jest.fn().mockResolvedValue(undefined),
            writeCategories: jest.fn().mockResolvedValue(undefined),
            writeTags: jest.fn().mockResolvedValue(undefined),
            writeCollections: jest.fn().mockResolvedValue(undefined),
            writeItem: jest.fn().mockResolvedValue(undefined),
            writeItemMarkdown: jest.fn().mockResolvedValue(undefined),
            writeComparison: jest.fn().mockResolvedValue(undefined),
            writeComparisonMarkdown: jest.fn().mockResolvedValue(undefined),
            ...overrides,
        };
    }

    function makeQueryRunner() {
        return {
            connect: jest.fn().mockResolvedValue(undefined),
            startTransaction: jest.fn().mockResolvedValue(undefined),
            commitTransaction: jest.fn().mockResolvedValue(undefined),
            rollbackTransaction: jest.fn().mockResolvedValue(undefined),
            release: jest.fn().mockResolvedValue(undefined),
        };
    }

    function makeService() {
        const queryRunner = makeQueryRunner();
        const dataSource = {
            createQueryRunner: jest.fn().mockReturnValue(queryRunner),
        };
        const data = makeData();
        dataRepoCreateMock.mockReset();
        dataRepoCreateMock.mockResolvedValue(data);

        const userRepository = {
            findById: jest.fn(),
        };
        const workRepository = {
            findByUser: jest.fn().mockResolvedValue([]),
            findByOwnerAndSlug: jest.fn().mockResolvedValue(null),
            existsByUserAndSlug: jest.fn().mockResolvedValue(false),
            create: jest.fn(),
            update: jest.fn(),
        };
        const workMemberRepository = {
            isMember: jest.fn().mockResolvedValue(false),
            addMember: jest.fn(),
        };
        const workCustomDomainRepository = {
            findOne: jest.fn().mockResolvedValue(null),
            addDomain: jest.fn(),
        };
        const userPluginRepository = {
            upsert: jest.fn(),
        };
        const workPluginRepository = {
            upsert: jest.fn(),
        };
        const pluginRepository = {
            findByPluginId: jest.fn(),
        };
        const advancedPromptsRepository = {
            createOrUpdate: jest.fn(),
        };
        const scheduleRepository = {
            upsert: jest.fn(),
        };
        const gitFacade = {
            cloneOrPull: jest.fn().mockResolvedValue('/tmp/clone'),
            addAll: jest.fn().mockResolvedValue(undefined),
            getStatus: jest.fn().mockResolvedValue([]),
            commit: jest.fn().mockResolvedValue(undefined),
            push: jest.fn().mockResolvedValue(undefined),
        };

        const service = new AccountImportService(
            dataSource as any,
            workRepository as any,
            workMemberRepository as any,
            workCustomDomainRepository as any,
            userPluginRepository as any,
            workPluginRepository as any,
            pluginRepository as any,
            userRepository as any,
            advancedPromptsRepository as any,
            scheduleRepository as any,
            gitFacade as any,
        );

        return {
            service,
            data,
            queryRunner,
            mocks: {
                dataSource,
                workRepository,
                workMemberRepository,
                workCustomDomainRepository,
                userPluginRepository,
                workPluginRepository,
                pluginRepository,
                userRepository,
                advancedPromptsRepository,
                scheduleRepository,
                gitFacade,
            },
        };
    }

    function makeWork(overrides: Partial<ExportedWork> = {}): ExportedWork {
        return {
            name: 'Best Tools',
            slug: 'best-tools',
            description: 'desc',
            owner: 'octocat',
            gitProvider: 'github',
            deployProvider: 'vercel',
            scheduledUpdatesEnabled: false,
            scheduledCadence: null,
            communityPrEnabled: false,
            communityPrAutoClose: false,
            comparisonsEnabled: true,
            members: [],
            customDomains: [],
            workPlugins: [],
            ...overrides,
        } as ExportedWork;
    }

    function makePayload(works: ExportedWork[], userPlugins: any[] = []): AccountExportPayload {
        return {
            version: 1,
            exportedAt: '2026-05-08T00:00:00.000Z',
            includesSecrets: false,
            data: {
                profile: { username: 'octocat', email: 'o@e.com' },
                works,
                userPlugins,
            },
        };
    }

    describe('previewImport — payload validation', () => {
        it('rejects null payload with the documented "Invalid payload" error', async () => {
            const { service } = makeService();
            const result = await service.previewImport('user-1', null as any);
            expect(result.valid).toBe(false);
            expect(result.errors).toEqual(['Invalid payload: expected a JSON object']);
            expect(result.version).toBe(0);
        });

        it('rejects non-object payload (e.g. a string)', async () => {
            const { service } = makeService();
            const result = await service.previewImport('user-1', 'not-an-object' as any);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toMatch(/Invalid payload/);
        });

        it('rejects unsupported version with a versioned error message', async () => {
            const { service } = makeService();
            const result = await service.previewImport('user-1', { version: 2 } as any);
            expect(result.valid).toBe(false);
            expect(result.errors).toEqual([
                'Unsupported export version: 2. Only version 1 is supported.',
            ]);
            expect(result.version).toBe(2);
        });

        it('reports version=0 in the envelope when payload.version is missing', async () => {
            const { service } = makeService();
            const result = await service.previewImport('user-1', {} as any);
            expect(result.version).toBe(0);
        });

        it('flags missing data field, missing profile, missing works array, missing userPlugins array', async () => {
            const { service } = makeService();
            const result = await service.previewImport('user-1', { version: 1 } as any);
            expect(result.valid).toBe(false);
            expect(result.errors).toEqual([
                'Missing data field in payload',
                'Missing profile data',
                'Missing or invalid works array',
                'Missing or invalid userPlugins array',
            ]);
        });

        it('flags individual missing fields when only some are absent', async () => {
            const { service } = makeService();
            const result = await service.previewImport('user-1', {
                version: 1,
                data: { profile: { username: 'x', email: 'x@x' }, works: [] },
            } as any);
            expect(result.valid).toBe(false);
            expect(result.errors).toEqual(['Missing or invalid userPlugins array']);
        });
    });

    describe('previewImport — conflict + missing-plugin detection', () => {
        it('returns valid:true with zero conflicts when nothing exists yet', async () => {
            const { service, mocks } = makeService();
            mocks.workRepository.findByUser.mockResolvedValue([]);
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p1' });

            const payload = makePayload([makeWork({ slug: 'a' }), makeWork({ slug: 'b' })]);
            const result = await service.previewImport('user-1', payload);

            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
            expect(result.workCount).toBe(2);
            expect(result.conflicts).toEqual([]);
            expect(result.missingPlugins).toEqual([]);
        });

        it('detects per-slug conflicts and emits {slug, existingName, incomingName}', async () => {
            const { service, mocks } = makeService();
            mocks.workRepository.findByUser.mockResolvedValue([
                { slug: 'a', name: 'Existing A' },
                { slug: 'c', name: 'Existing C' },
            ]);

            const payload = makePayload([
                makeWork({ slug: 'a', name: 'Incoming A' }),
                makeWork({ slug: 'b', name: 'New B' }),
            ]);
            const result = await service.previewImport('user-1', payload);

            expect(result.conflicts).toEqual([
                { slug: 'a', existingName: 'Existing A', incomingName: 'Incoming A' },
            ]);
        });

        it('lists missing plugins (across both userPlugins and workPlugins) once each', async () => {
            const { service, mocks } = makeService();
            mocks.workRepository.findByUser.mockResolvedValue([]);
            mocks.pluginRepository.findByPluginId.mockImplementation(async (id: string) =>
                id === 'tavily' ? { id: 't' } : null,
            );

            const payload = makePayload(
                [
                    makeWork({
                        slug: 'a',
                        workPlugins: [
                            { pluginId: 'openai', enabled: true, settings: {}, priority: 0 },
                        ],
                    }),
                ],
                [
                    {
                        pluginId: 'tavily',
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                    },
                    {
                        pluginId: 'anthropic',
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                    },
                ],
            );

            const result = await service.previewImport('user-1', payload);

            expect(result.missingPlugins.sort()).toEqual(['anthropic', 'openai'].sort());
            expect(result.missingPlugins).not.toContain('tavily');
        });

        it('counts items across all works for totalItemCount', async () => {
            const { service, mocks } = makeService();
            mocks.workRepository.findByUser.mockResolvedValue([]);
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            const payload = makePayload([
                makeWork({ slug: 'a', items: [{}, {}, {}] as any }),
                makeWork({ slug: 'b', items: [{}, {}] as any }),
                makeWork({ slug: 'c' }),
            ]);
            const result = await service.previewImport('user-1', payload);
            expect(result.totalItemCount).toBe(5);
        });

        it('detects masked secrets in userPlugins and short-circuits to true', async () => {
            const { service, mocks } = makeService();
            mocks.workRepository.findByUser.mockResolvedValue([]);
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            const payload = makePayload(
                [makeWork({ slug: 'a' })],
                [
                    {
                        pluginId: 'tavily',
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                        secretSettings: { apiKey: `${MASKED_SECRET_PREFIX}abc***1234` },
                    },
                ],
            );
            const result = await service.previewImport('user-1', payload);
            expect(result.hasMaskedSecrets).toBe(true);
        });

        it('detects masked secrets in workPlugins when userPlugins are clean', async () => {
            const { service, mocks } = makeService();
            mocks.workRepository.findByUser.mockResolvedValue([]);
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            const payload = makePayload(
                [
                    makeWork({
                        slug: 'a',
                        workPlugins: [
                            {
                                pluginId: 'openai',
                                enabled: true,
                                settings: {},
                                secretSettings: { apiKey: `${MASKED_SECRET_PREFIX}abc***1234` },
                                priority: 0,
                            },
                        ],
                    }),
                ],
                [
                    {
                        pluginId: 'tavily',
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                        secretSettings: { apiKey: 'real-key' },
                    },
                ],
            );
            const result = await service.previewImport('user-1', payload);
            expect(result.hasMaskedSecrets).toBe(true);
        });

        it('hasMaskedSecrets is false when no plugin has masked values', async () => {
            const { service, mocks } = makeService();
            mocks.workRepository.findByUser.mockResolvedValue([]);
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            const payload = makePayload(
                [makeWork({ slug: 'a' })],
                [
                    {
                        pluginId: 'tavily',
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                        secretSettings: { apiKey: 'real-key-9999' },
                    },
                ],
            );
            const result = await service.previewImport('user-1', payload);
            expect(result.hasMaskedSecrets).toBe(false);
        });

        it('mirrors payload.includesSecrets onto the preview envelope', async () => {
            const { service, mocks } = makeService();
            mocks.workRepository.findByUser.mockResolvedValue([]);

            const payload = makePayload([makeWork({ slug: 'a' })]);
            payload.includesSecrets = true;
            const result = await service.previewImport('user-1', payload);
            expect(result.includesSecrets).toBe(true);
        });
    });

    describe('applyImport — top-level transaction lifecycle', () => {
        it('returns success:false with "User not found" when the importing user is missing', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue(null);

            const result = await service.applyImport('user-x', makePayload([], []), []);

            expect(result.success).toBe(false);
            expect(result.errors).toEqual(['User not found']);
        });

        it('connects, starts a transaction, and commits + releases on success', async () => {
            const { service, mocks, queryRunner } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octo' });

            const result = await service.applyImport('user-1', makePayload([], []), []);

            expect(queryRunner.connect).toHaveBeenCalledTimes(1);
            expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1);
            expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
            expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
            expect(queryRunner.release).toHaveBeenCalledTimes(1);
            expect(result.success).toBe(true);
        });

        it('rolls back + releases when committing throws (e.g. constraint violation)', async () => {
            const { service, mocks, queryRunner } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octo' });
            queryRunner.commitTransaction.mockRejectedValue(new Error('commit-fail'));

            const result = await service.applyImport('user-1', makePayload([], []), []);

            expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
            expect(queryRunner.release).toHaveBeenCalledTimes(1);
            expect(result.success).toBe(false);
            expect(result.errors[0]).toMatch(/Transaction failed: commit-fail/);
        });

        it('coerces non-Error transaction failures to String(error) in the error message', async () => {
            const { service, mocks, queryRunner } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octo' });
            queryRunner.commitTransaction.mockRejectedValue('plain-string');

            const result = await service.applyImport('user-1', makePayload([], []), []);
            expect(result.errors[0]).toBe('Transaction failed: plain-string');
        });
    });

    describe('applyImport — per-work conflict resolution', () => {
        it('skips on missing resolution (default behaviour) and increments worksSkipped', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue({ id: 'w-existing' });

            const result = await service.applyImport(
                'user-1',
                makePayload([makeWork({ slug: 'a' })]),
                [],
            );

            expect(result.worksSkipped).toBe(1);
            expect(result.worksUpdated).toBe(0);
            expect(result.worksCreated).toBe(0);
            expect(mocks.workRepository.update).not.toHaveBeenCalled();
            expect(mocks.workRepository.create).not.toHaveBeenCalled();
        });

        it('skips when explicit resolution.strategy === "skip"', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue({ id: 'w-existing' });

            const resolutions: ConflictResolution[] = [{ slug: 'a', strategy: 'skip' }];
            const result = await service.applyImport(
                'user-1',
                makePayload([makeWork({ slug: 'a' })]),
                resolutions,
            );

            expect(result.worksSkipped).toBe(1);
        });

        it('overwrite calls workRepository.update with the work-level fields and increments worksUpdated', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            const existing = { id: 'w-existing', slug: 'a', getRepoOwner: () => 'octocat' };
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(existing);

            const resolutions: ConflictResolution[] = [{ slug: 'a', strategy: 'overwrite' }];
            const result = await service.applyImport(
                'user-1',
                makePayload([makeWork({ slug: 'a', name: 'Renamed', description: 'new desc' })]),
                resolutions,
            );

            expect(mocks.workRepository.update).toHaveBeenCalledWith(
                'w-existing',
                expect.objectContaining({ name: 'Renamed', description: 'new desc' }),
            );
            expect(result.worksUpdated).toBe(1);
            expect(result.worksCreated).toBe(0);
        });

        it('rename strategy uses resolution.newSlug when provided', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue({ id: 'w-existing' });
            mocks.workRepository.existsByUserAndSlug.mockResolvedValue(false);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-new', slug: 'a-renamed' });

            const resolutions: ConflictResolution[] = [
                { slug: 'a', strategy: 'rename', newSlug: 'a-renamed' },
            ];
            const result = await service.applyImport(
                'user-1',
                makePayload([makeWork({ slug: 'a' })]),
                resolutions,
            );

            expect(mocks.workRepository.existsByUserAndSlug).toHaveBeenCalledWith(
                'user-1',
                'a-renamed',
            );
            expect(mocks.workRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({ slug: 'a-renamed' }),
                expect.anything(),
            );
            expect(result.worksCreated).toBe(1);
        });

        it('rename strategy falls back to `${slug}-imported` when newSlug is missing', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue({ id: 'w-existing' });
            mocks.workRepository.existsByUserAndSlug.mockResolvedValue(false);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-new', slug: 'a-imported' });

            await service.applyImport('user-1', makePayload([makeWork({ slug: 'a' })]), [
                { slug: 'a', strategy: 'rename' },
            ]);

            expect(mocks.workRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({ slug: 'a-imported' }),
                expect.anything(),
            );
        });

        it('rename rejects (and skips) when the new slug also collides for the same user', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue({ id: 'w-existing' });
            mocks.workRepository.existsByUserAndSlug.mockResolvedValue(true);

            const result = await service.applyImport(
                'user-1',
                makePayload([makeWork({ slug: 'a' })]),
                [{ slug: 'a', strategy: 'rename', newSlug: 'b' }],
            );

            expect(mocks.workRepository.create).not.toHaveBeenCalled();
            expect(result.worksSkipped).toBe(1);
            expect(result.errors).toEqual(['Cannot rename "a" to "b" - slug already exists']);
        });

        it('creates a NEW work when no existing row is found, defaulting owner to user.username', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-new', slug: 'a' });

            const result = await service.applyImport(
                'user-1',
                makePayload([makeWork({ slug: 'a', owner: undefined })]),
                [],
            );

            const [payload, user] = mocks.workRepository.create.mock.calls[0];
            expect(payload.owner).toBe('octocat'); // fallback
            expect(payload.userId).toBe('user-1');
            expect(user.username).toBe('octocat');
            expect(result.worksCreated).toBe(1);
        });

        it('per-work failure inside the loop is caught and pushed to result.errors WITHOUT aborting other works', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create
                .mockRejectedValueOnce(new Error('first-failed'))
                .mockResolvedValueOnce({ id: 'w-2', slug: 'b' });

            const result = await service.applyImport(
                'user-1',
                makePayload([
                    makeWork({ slug: 'a', name: 'A' }),
                    makeWork({ slug: 'b', name: 'B' }),
                ]),
                [],
            );

            expect(result.errors).toEqual(['Failed to import work "a": first-failed']);
            expect(result.worksCreated).toBe(1);
            expect(mocks.workRepository.create).toHaveBeenCalledTimes(2);
        });
    });

    describe('applyImport — userPlugin import', () => {
        it('skips userPlugins whose underlying plugin row is missing on this instance', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue(null);

            const payload = makePayload(
                [],
                [
                    {
                        pluginId: 'tavily',
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                    },
                ],
            );
            const result = await service.applyImport('user-1', payload, []);

            expect(mocks.userPluginRepository.upsert).not.toHaveBeenCalled();
            expect(result.warnings).toEqual([
                'Plugin "tavily" is not installed on this instance, skipping',
            ]);
            expect(result.userPluginsImported).toBe(0);
        });

        it('upserts userPlugin without secretSettings when payload.includesSecrets is false', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p-tavily' });

            const payload = makePayload(
                [],
                [
                    {
                        pluginId: 'tavily',
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: { region: 'us' },
                        secretSettings: { apiKey: 'real-key' },
                    },
                ],
            );
            const result = await service.applyImport('user-1', payload, []);

            expect(mocks.userPluginRepository.upsert).toHaveBeenCalledTimes(1);
            const arg = mocks.userPluginRepository.upsert.mock.calls[0][0];
            expect(arg.secretSettings).toBeUndefined();
            expect(arg.settings).toEqual({ region: 'us' });
            expect(arg.pluginEntityId).toBe('p-tavily');
            expect(result.userPluginsImported).toBe(1);
        });

        it('writes real secretSettings when includesSecrets:true AND values are not masked', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p-tavily' });

            const payload = makePayload(
                [],
                [
                    {
                        pluginId: 'tavily',
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                        secretSettings: { apiKey: 'real-key' },
                    },
                ],
            );
            payload.includesSecrets = true;
            await service.applyImport('user-1', payload, []);

            const arg = mocks.userPluginRepository.upsert.mock.calls[0][0];
            expect(arg.secretSettings).toEqual({ apiKey: 'real-key' });
        });

        it('warns + skips secretSettings when payload contains masked values (placeholders, not credentials)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p-tavily' });

            const payload = makePayload(
                [],
                [
                    {
                        pluginId: 'tavily',
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                        secretSettings: { apiKey: `${MASKED_SECRET_PREFIX}abc***1234` },
                    },
                ],
            );
            payload.includesSecrets = true;
            const result = await service.applyImport('user-1', payload, []);

            const arg = mocks.userPluginRepository.upsert.mock.calls[0][0];
            expect(arg.secretSettings).toBeUndefined();
            expect(result.warnings.some((w) => w.includes('masked secret values'))).toBe(true);
            expect(result.userPluginsImported).toBe(1);
        });

        it('per-userPlugin failure is captured in result.errors without aborting other plugins', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });
            mocks.userPluginRepository.upsert
                .mockRejectedValueOnce(new Error('upsert-fail'))
                .mockResolvedValueOnce(undefined);

            const payload = makePayload(
                [],
                [
                    {
                        pluginId: 'a',
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                    },
                    {
                        pluginId: 'b',
                        enabled: true,
                        autoEnableForWorks: false,
                        settings: {},
                    },
                ],
            );
            const result = await service.applyImport('user-1', payload, []);

            expect(result.errors).toEqual(['Failed to import user plugin "a": upsert-fail']);
            expect(result.userPluginsImported).toBe(1);
        });
    });

    describe('importWorkRelations', () => {
        function makeWorkWithRelations(): ExportedWork {
            return makeWork({
                slug: 'a',
                members: [{ userId: 'm1', role: 'editor' }],
                customDomains: [
                    { domain: 'a.test', environment: 'prod', verified: true, provider: 'cf' },
                ],
                workPlugins: [
                    {
                        pluginId: 'openai',
                        enabled: true,
                        activeCapabilities: ['ai-provider'],
                        settings: {},
                        priority: 0,
                    },
                ],
                advancedPrompts: { itemGeneration: 'foo' },
                schedule: {
                    cadence: 'daily',
                    status: 'active',
                    billingMode: 'plan',
                    alwaysCreatePullRequest: false,
                    maxFailureBeforePause: 3,
                    providerOverrides: null,
                },
            });
        }

        it('skips a member if their userId does not exist on this instance (warning)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById
                .mockResolvedValueOnce({ id: 'user-1', username: 'octocat' }) // importer
                .mockResolvedValueOnce(null); // member lookup
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            const result = await service.applyImport(
                'user-1',
                makePayload([makeWorkWithRelations()]),
                [],
            );

            expect(mocks.workMemberRepository.addMember).not.toHaveBeenCalled();
            expect(result.warnings.some((w) => w.includes('Member user "m1" not found'))).toBe(
                true,
            );
        });

        it('addMember is skipped when isMember already returns true (idempotent re-import)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById
                .mockResolvedValueOnce({ id: 'user-1', username: 'octocat' })
                .mockResolvedValueOnce({ id: 'm1' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.workMemberRepository.isMember.mockResolvedValue(true);
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            await service.applyImport('user-1', makePayload([makeWorkWithRelations()]), []);

            expect(mocks.workMemberRepository.addMember).not.toHaveBeenCalled();
        });

        it('addMember runs with positional (workId, userId, role) when not already a member', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById
                .mockResolvedValueOnce({ id: 'user-1', username: 'octocat' })
                .mockResolvedValueOnce({ id: 'm1' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            await service.applyImport('user-1', makePayload([makeWorkWithRelations()]), []);

            expect(mocks.workMemberRepository.addMember).toHaveBeenCalledWith(
                'w-1',
                'm1',
                'editor',
            );
        });

        it('skips an existing customDomain (idempotent), and adds a new one with (workId, domain, provider)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.workCustomDomainRepository.findOne.mockResolvedValue(null);
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            await service.applyImport('user-1', makePayload([makeWorkWithRelations()]), []);

            expect(mocks.workCustomDomainRepository.addDomain).toHaveBeenCalledWith(
                'w-1',
                'a.test',
                'cf',
            );
        });

        it('passes advancedPrompts through to the repository when at least one field is present', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            await service.applyImport('user-1', makePayload([makeWorkWithRelations()]), []);

            expect(mocks.advancedPromptsRepository.createOrUpdate).toHaveBeenCalledWith(
                'w-1',
                expect.objectContaining({ itemGeneration: 'foo' }),
            );
        });

        it('skips advancedPrompts entirely when the prompts envelope is empty', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            const work = makeWork({ slug: 'a', advancedPrompts: {} });
            await service.applyImport('user-1', makePayload([work]), []);

            expect(mocks.advancedPromptsRepository.createOrUpdate).not.toHaveBeenCalled();
        });

        it('upserts the schedule with userId merged from the function arg (not from the export)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            await service.applyImport('user-1', makePayload([makeWorkWithRelations()]), []);

            expect(mocks.scheduleRepository.upsert).toHaveBeenCalledWith(
                'w-1',
                expect.objectContaining({
                    userId: 'user-1',
                    cadence: 'daily',
                    status: 'active',
                    providerOverrides: null,
                }),
            );
        });

        it('falls back activeCapabilities from legacy single `activeCapability` when array is missing', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            const work = makeWork({
                slug: 'a',
                workPlugins: [
                    {
                        pluginId: 'openai',
                        enabled: true,
                        activeCapability: 'ai-provider', // legacy single field
                        settings: {},
                        priority: 0,
                    },
                ],
            });
            await service.applyImport('user-1', makePayload([work]), []);

            expect(mocks.workPluginRepository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ activeCapabilities: ['ai-provider'] }),
            );
        });

        it('legacy + missing activeCapability → empty array (no crash)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            const work = makeWork({
                slug: 'a',
                workPlugins: [
                    {
                        pluginId: 'openai',
                        enabled: true,
                        settings: {},
                        priority: 0,
                    },
                ],
            });
            await service.applyImport('user-1', makePayload([work]), []);

            expect(mocks.workPluginRepository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ activeCapabilities: [] }),
            );
        });

        it('skips a workPlugin when the plugin row is missing (warning, no upsert)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue(null);

            const work = makeWork({
                slug: 'a',
                workPlugins: [
                    {
                        pluginId: 'openai',
                        enabled: true,
                        activeCapabilities: ['ai-provider'],
                        settings: {},
                        priority: 0,
                    },
                ],
            });
            const result = await service.applyImport('user-1', makePayload([work]), []);

            expect(mocks.workPluginRepository.upsert).not.toHaveBeenCalled();
            expect(
                result.warnings.some((w) => w.includes('Plugin "openai" is not installed')),
            ).toBe(true);
        });

        it('warns + skips secretSettings on workPlugins when masked values are present (real settings still written)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            const work = makeWork({
                slug: 'a',
                workPlugins: [
                    {
                        pluginId: 'openai',
                        enabled: true,
                        activeCapabilities: ['ai-provider'],
                        settings: { model: 'gpt-4o' },
                        secretSettings: { apiKey: `${MASKED_SECRET_PREFIX}abc***1234` },
                        priority: 0,
                    },
                ],
            });
            const payload = makePayload([work]);
            payload.includesSecrets = true;
            const result = await service.applyImport('user-1', payload, []);

            expect(mocks.workPluginRepository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    settings: { model: 'gpt-4o' },
                    secretSettings: {},
                }),
            );
            expect(
                result.warnings.some((w) =>
                    w.includes('Work plugin "openai" has masked secret values'),
                ),
            ).toBe(true);
        });

        it('writes real workPlugin secrets when includesSecrets:true and values are NOT masked', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });
            mocks.pluginRepository.findByPluginId.mockResolvedValue({ id: 'p' });

            const work = makeWork({
                slug: 'a',
                workPlugins: [
                    {
                        pluginId: 'openai',
                        enabled: true,
                        activeCapabilities: ['ai-provider'],
                        settings: {},
                        secretSettings: { apiKey: 'real-key' },
                        priority: 0,
                    },
                ],
            });
            const payload = makePayload([work]);
            payload.includesSecrets = true;
            await service.applyImport('user-1', payload, []);

            expect(mocks.workPluginRepository.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ secretSettings: { apiKey: 'real-key' } }),
            );
        });
    });

    describe('importWorkRepoData', () => {
        it('does NOT clone the data repo when there is nothing to write (no items / comparisons / config / template)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({ id: 'w-1', slug: 'a' });

            await service.applyImport('user-1', makePayload([makeWork({ slug: 'a' })]), []);

            expect(mocks.gitFacade.cloneOrPull).not.toHaveBeenCalled();
        });

        it('writes site config + markdown template + categories/tags/collections + items + comparisons through DataRepository, then commits + pushes only if status non-empty', async () => {
            const { service, data, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({
                id: 'w-1',
                slug: 'a',
                userId: 'user-1',
                getRepoOwner: () => 'octocat',
            });
            mocks.gitFacade.getStatus.mockResolvedValue([{ file: 'config.json' }]);

            const work = makeWork({
                slug: 'a',
                items: [
                    {
                        name: 'A',
                        description: 'd',
                        source_url: 'u',
                        category: 'c',
                        tags: [],
                        markdown: '# md',
                    },
                ] as any,
                comparisons: [
                    {
                        id: 'c1',
                        slug: 'a-vs-b',
                        markdown: '# c md',
                    },
                ] as any,
                siteConfig: { siteName: 'Best' },
                markdownTemplate: { header: 'H', footer: 'F' },
                categories: [{ id: 'c1', name: 'C' }],
                tags: [{ id: 't1', name: 'T' }],
                collections: [{ id: 'col1', name: 'Col' }],
            });

            await service.applyImport('user-1', makePayload([work]), []);

            expect(data.writeConfig).toHaveBeenCalledWith({ siteName: 'Best' });
            expect(data.writeMarkdownTemplate).toHaveBeenCalledWith('H', 'F');
            expect(data.writeCategories).toHaveBeenCalledWith([{ id: 'c1', name: 'C' }]);
            expect(data.writeTags).toHaveBeenCalledWith([{ id: 't1', name: 'T' }]);
            expect(data.writeCollections).toHaveBeenCalledWith([{ id: 'col1', name: 'Col' }]);

            // Item: markdown is stripped from the data write and re-written separately
            expect(data.writeItem).toHaveBeenCalledWith(expect.objectContaining({ name: 'A' }));
            const itemCallArg = data.writeItem.mock.calls[0][0];
            expect(itemCallArg.markdown).toBeUndefined();
            expect(data.writeItemMarkdown).toHaveBeenCalledWith(expect.anything(), '# md');

            // Comparison: same markdown-strip pattern
            expect(data.writeComparison).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'c1' }),
            );
            const compCallArg = data.writeComparison.mock.calls[0][0];
            expect(compCallArg.markdown).toBeUndefined();
            expect(data.writeComparisonMarkdown).toHaveBeenCalledWith('a-vs-b', '# c md');

            expect(mocks.gitFacade.commit).toHaveBeenCalled();
            expect(mocks.gitFacade.push).toHaveBeenCalled();
        });

        it('does NOT commit + push when getStatus returns an empty array (no actual changes)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({
                id: 'w-1',
                slug: 'a',
                userId: 'user-1',
                getRepoOwner: () => 'octocat',
            });
            mocks.gitFacade.getStatus.mockResolvedValue([]); // nothing changed

            const work = makeWork({
                slug: 'a',
                siteConfig: { siteName: 'x' },
            });
            await service.applyImport('user-1', makePayload([work]), []);

            expect(mocks.gitFacade.commit).not.toHaveBeenCalled();
            expect(mocks.gitFacade.push).not.toHaveBeenCalled();
        });

        it('builds the "import: restore …" commit message from the present sections', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({
                id: 'w-1',
                slug: 'a',
                userId: 'user-1',
                getRepoOwner: () => 'octocat',
            });
            mocks.gitFacade.getStatus.mockResolvedValue([{ file: 'x' }]);

            const work = makeWork({
                slug: 'a',
                items: [
                    { name: 'A', description: 'd', source_url: 'u', category: 'c', tags: [] },
                ] as any,
                siteConfig: { siteName: 'Best' },
            });
            await service.applyImport('user-1', makePayload([work]), []);

            const commitArgs = mocks.gitFacade.commit.mock.calls[0];
            // (provider, dest, message, committer)
            expect(commitArgs[2]).toBe('import: restore 1 items, site config from account export');
        });

        it('per-work repo-data failures are caught and emitted as warnings (not as errors that abort the loop)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            mocks.workRepository.create.mockResolvedValue({
                id: 'w-1',
                slug: 'a',
                userId: 'user-1',
                getRepoOwner: () => 'octocat',
            });
            mocks.gitFacade.cloneOrPull.mockRejectedValue(new Error('clone-fail'));

            const work = makeWork({
                slug: 'a',
                items: [
                    { name: 'A', description: 'd', source_url: 'u', category: 'c', tags: [] },
                ] as any,
            });
            const result = await service.applyImport('user-1', makePayload([work]), []);

            expect(
                result.warnings.some((w) =>
                    w.includes('Repo data for work "a" could not be imported: clone-fail'),
                ),
            ).toBe(true);
            expect(result.worksCreated).toBe(1); // work creation still succeeded
        });

        it('falls back to user.username when work.getRepoOwner is missing (legacy work shape)', async () => {
            const { service, mocks } = makeService();
            mocks.userRepository.findById.mockResolvedValue({ id: 'user-1', username: 'octocat' });
            mocks.workRepository.findByOwnerAndSlug.mockResolvedValue(null);
            // No getRepoOwner method on the created row
            mocks.workRepository.create.mockResolvedValue({
                id: 'w-1',
                slug: 'a',
                userId: 'user-1',
            });
            mocks.gitFacade.getStatus.mockResolvedValue([]);

            const work = makeWork({
                slug: 'a',
                owner: 'someoneelse', // takes priority over user.username because getRepoOwner is missing
                siteConfig: { foo: 1 },
            });
            await service.applyImport('user-1', makePayload([work]), []);

            // owner from the export takes precedence over user.username
            expect(mocks.gitFacade.cloneOrPull).toHaveBeenCalledWith(
                expect.objectContaining({ owner: 'someoneelse' }),
                expect.anything(),
            );
        });
    });
});

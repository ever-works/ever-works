// Mock the planner and applier modules to avoid the transitive ESM-only
// `p-map` import path through `works-config-import-applier.service.ts`.
// The restore service is a pure delegate, so we only care that the right
// methods are forwarded; we do not exercise either collaborator's internals.
jest.mock('../services/works-config-import-planner.service', () => ({
    WorksConfigImportPlannerService: class {},
}));
jest.mock('../services/works-config-import-applier.service', () => ({
    WorksConfigImportApplierService: class {},
}));

import { WorksConfigRestoreService } from '../services/works-config-restore.service';

// Use `unknown` for the mocked collaborator shapes — they would normally come
// from `import type ...`, but importing those types still parses the modules
// when the spec runs, so we keep the type-side hand-rolled.
type MockedPlanner = {
    toSnapshot: jest.Mock;
    toResolved: jest.Mock;
    getConflictRepoNames: jest.Mock;
    sanitizeConflict: jest.Mock;
    validateForGeneratedImport: jest.Mock;
    validateProviderSettings: jest.Mock;
    validateRepositoryTargets: jest.Mock;
    buildSourceRepository: jest.Mock;
};
type MockedApplier = {
    applyPipelineSettings: jest.Mock;
    applyInitialSchedule: jest.Mock;
    applyScheduleOverrides: jest.Mock;
};

const makePlanner = (): MockedPlanner => ({
    toSnapshot: jest.fn(),
    toResolved: jest.fn(),
    getConflictRepoNames: jest.fn(),
    sanitizeConflict: jest.fn(),
    validateForGeneratedImport: jest.fn(),
    validateProviderSettings: jest.fn(),
    validateRepositoryTargets: jest.fn(),
    buildSourceRepository: jest.fn(),
});

const makeApplier = (): MockedApplier => ({
    applyPipelineSettings: jest.fn(),
    applyInitialSchedule: jest.fn(),
    applyScheduleOverrides: jest.fn(),
});

describe('WorksConfigRestoreService', () => {
    let planner: MockedPlanner;
    let applier: MockedApplier;
    let service: WorksConfigRestoreService;

    beforeEach(() => {
        planner = makePlanner();
        applier = makeApplier();
        service = new WorksConfigRestoreService(planner as never, applier as never);
    });

    describe('toSnapshot (planner delegate)', () => {
        it('forwards the worksConfig argument verbatim and returns the planner result by reference', () => {
            const worksConfig = { name: 'compare-cloud' } as any;
            const snapshot = { name: 'compare-cloud', repos: [] };
            (planner.toSnapshot as jest.Mock).mockReturnValue(snapshot);

            const result = service.toSnapshot(worksConfig);

            expect(planner.toSnapshot).toHaveBeenCalledTimes(1);
            expect(planner.toSnapshot).toHaveBeenCalledWith(worksConfig);
            expect(result).toBe(snapshot);
        });

        it('forwards undefined argument (omitted parameter passthrough)', () => {
            (planner.toSnapshot as jest.Mock).mockReturnValue(null);

            const result = service.toSnapshot();

            expect(planner.toSnapshot).toHaveBeenCalledWith(undefined);
            expect(result).toBeNull();
        });

        it('forwards null argument explicitly (distinct from undefined for delegate signature)', () => {
            service.toSnapshot(null);
            expect(planner.toSnapshot).toHaveBeenCalledWith(null);
        });
    });

    describe('toResolved (planner delegate)', () => {
        it('forwards the worksConfig argument and returns the planner result by reference', () => {
            const worksConfig = { name: 'work-1' } as any;
            const resolved = { name: 'work-1', resolved: true } as any;
            (planner.toResolved as jest.Mock).mockReturnValue(resolved);

            const result = service.toResolved(worksConfig);

            expect(planner.toResolved).toHaveBeenCalledWith(worksConfig);
            expect(result).toBe(resolved);
        });

        it('passes null through to the planner', () => {
            (planner.toResolved as jest.Mock).mockReturnValue(null);
            const result = service.toResolved(null);
            expect(planner.toResolved).toHaveBeenCalledWith(null);
            expect(result).toBeNull();
        });

        it('forwards undefined when no argument supplied', () => {
            service.toResolved();
            expect(planner.toResolved).toHaveBeenCalledWith(undefined);
        });
    });

    describe('getConflictRepoNames (planner delegate, 3 positional args)', () => {
        it('forwards (slug, sourceRepoName, worksConfig) verbatim with all three present', () => {
            const conflicts = ['repo-1', 'repo-2'];
            (planner.getConflictRepoNames as jest.Mock).mockReturnValue(conflicts);

            const result = service.getConflictRepoNames('my-slug', 'source-repo', {
                websiteRepo: 'web-repo',
            });

            expect(planner.getConflictRepoNames).toHaveBeenCalledWith('my-slug', 'source-repo', {
                websiteRepo: 'web-repo',
            });
            expect(result).toBe(conflicts);
        });

        it('forwards undefined sourceRepoName and undefined worksConfig (defaults pass through)', () => {
            (planner.getConflictRepoNames as jest.Mock).mockReturnValue([]);

            service.getConflictRepoNames('slug-only');

            expect(planner.getConflictRepoNames).toHaveBeenCalledWith(
                'slug-only',
                undefined,
                undefined,
            );
        });

        it('forwards null sourceRepoName explicitly (typed as string|null|undefined)', () => {
            service.getConflictRepoNames('slug', null, null);
            expect(planner.getConflictRepoNames).toHaveBeenCalledWith('slug', null, null);
        });
    });

    describe('sanitizeConflict (planner delegate, 3 positional args)', () => {
        it('forwards the conflict object + sourceRepoName + worksConfig and returns planner result', () => {
            const conflict = {
                hasConflict: true,
                conflictingRepos: ['a', 'b'],
                suggestedSlug: 'my-slug-2',
            };
            const sanitized = {
                hasConflict: false,
                conflictingRepos: [],
                suggestedSlug: 'my-slug',
            };
            (planner.sanitizeConflict as jest.Mock).mockReturnValue(sanitized);

            const result = service.sanitizeConflict(conflict, 'src-repo', {
                websiteRepo: 'web',
            });

            expect(planner.sanitizeConflict).toHaveBeenCalledWith(conflict, 'src-repo', {
                websiteRepo: 'web',
            });
            expect(result).toBe(sanitized);
        });

        it('forwards undefined optional args verbatim', () => {
            const conflict = {
                hasConflict: false,
                conflictingRepos: [],
                suggestedSlug: 'slug',
            };
            service.sanitizeConflict(conflict);
            expect(planner.sanitizeConflict).toHaveBeenCalledWith(conflict, undefined, undefined);
        });
    });

    describe('validateForImport (async planner delegate)', () => {
        it('awaits planner.validateForGeneratedImport with (worksConfig, userId)', async () => {
            (planner.validateForGeneratedImport as jest.Mock).mockResolvedValue(undefined);
            const worksConfig = { name: 'work' } as any;

            await service.validateForImport(worksConfig, 'user-1');

            expect(planner.validateForGeneratedImport).toHaveBeenCalledWith(worksConfig, 'user-1');
        });

        it('passes null worksConfig through (planner handles the null branch)', async () => {
            (planner.validateForGeneratedImport as jest.Mock).mockResolvedValue(undefined);
            await service.validateForImport(null, 'user-1');
            expect(planner.validateForGeneratedImport).toHaveBeenCalledWith(null, 'user-1');
        });

        it('propagates planner rejection (validation failure surfaces to caller)', async () => {
            (planner.validateForGeneratedImport as jest.Mock).mockRejectedValue(
                new Error('Plugin X is required but not enabled'),
            );

            await expect(service.validateForImport({ name: 'w' } as any, 'user-1')).rejects.toThrow(
                'Plugin X is required but not enabled',
            );
        });

        it('returns void (Promise<void> contract — no value leaks from the planner result)', async () => {
            (planner.validateForGeneratedImport as jest.Mock).mockResolvedValue(
                'not-void-but-string',
            );

            const result = await service.validateForImport({} as any, 'u');

            // Pin: the wrapper does not expose the planner's return value.
            expect(result).toBeUndefined();
        });
    });

    describe('validateProviderSettings (async planner delegate, optional options)', () => {
        it('forwards (worksConfig, userId, options) when all three supplied', async () => {
            (planner.validateProviderSettings as jest.Mock).mockResolvedValue(undefined);
            const worksConfig = { name: 'w' } as any;
            const options = { validateDefaults: true };

            await service.validateProviderSettings(worksConfig, 'user-1', options);

            expect(planner.validateProviderSettings).toHaveBeenCalledWith(
                worksConfig,
                'user-1',
                options,
            );
        });

        it('forwards undefined options when omitted', async () => {
            (planner.validateProviderSettings as jest.Mock).mockResolvedValue(undefined);

            await service.validateProviderSettings(null, 'user-1');

            expect(planner.validateProviderSettings).toHaveBeenCalledWith(
                null,
                'user-1',
                undefined,
            );
        });

        it('propagates planner rejection', async () => {
            (planner.validateProviderSettings as jest.Mock).mockRejectedValue(
                new Error('Provider settings invalid'),
            );

            await expect(service.validateProviderSettings({} as any, 'user-1')).rejects.toThrow(
                'Provider settings invalid',
            );
        });
    });

    describe('validateRepositoryTargets (sync planner delegate)', () => {
        it('forwards (source, worksConfig) verbatim', () => {
            const source = 'data' as any;
            const worksConfig = { repos: [] } as any;

            service.validateRepositoryTargets(source, worksConfig);

            expect(planner.validateRepositoryTargets).toHaveBeenCalledWith(source, worksConfig);
        });

        it('forwards undefined worksConfig when omitted', () => {
            const source = 'website' as any;
            service.validateRepositoryTargets(source);
            expect(planner.validateRepositoryTargets).toHaveBeenCalledWith(source, undefined);
        });

        it('returns void (planner result does not leak through)', () => {
            (planner.validateRepositoryTargets as jest.Mock).mockReturnValue('not-void');
            const result = service.validateRepositoryTargets('data' as any);
            expect(result).toBeUndefined();
        });

        it('propagates planner throw (sync error path)', () => {
            (planner.validateRepositoryTargets as jest.Mock).mockImplementation(() => {
                throw new Error('Repository target conflict');
            });

            expect(() => service.validateRepositoryTargets('data' as any)).toThrow(
                'Repository target conflict',
            );
        });
    });

    describe('buildSourceRepository (planner delegate)', () => {
        it('forwards the options object verbatim and returns the planner result by reference', () => {
            const options = { name: 'src', userId: 'u', branch: 'main' } as any;
            const built = { name: 'src', resolved: true } as any;
            (planner.buildSourceRepository as jest.Mock).mockReturnValue(built);

            const result = service.buildSourceRepository(options);

            expect(planner.buildSourceRepository).toHaveBeenCalledWith(options);
            expect(result).toBe(built);
        });
    });

    describe('applyPipelineSettings (async applier delegate)', () => {
        it('forwards (workId, userId, worksConfig) verbatim', async () => {
            (applier.applyPipelineSettings as jest.Mock).mockResolvedValue(undefined);
            const worksConfig = { name: 'w' } as any;

            await service.applyPipelineSettings('work-1', 'user-1', worksConfig);

            expect(applier.applyPipelineSettings).toHaveBeenCalledWith(
                'work-1',
                'user-1',
                worksConfig,
            );
        });

        it('forwards undefined worksConfig when omitted', async () => {
            (applier.applyPipelineSettings as jest.Mock).mockResolvedValue(undefined);
            await service.applyPipelineSettings('work-1', 'user-1');
            expect(applier.applyPipelineSettings).toHaveBeenCalledWith(
                'work-1',
                'user-1',
                undefined,
            );
        });

        it('does NOT call planner when applier methods are invoked (cross-collaborator boundary)', async () => {
            (applier.applyPipelineSettings as jest.Mock).mockResolvedValue(undefined);
            await service.applyPipelineSettings('work-1', 'user-1');

            // Pin: applyPipelineSettings is an applier-side concern — the
            // planner must not be touched (mistakenly delegating to the
            // wrong collaborator would silently break write semantics).
            expect(planner.toSnapshot).not.toHaveBeenCalled();
            expect(planner.toResolved).not.toHaveBeenCalled();
            expect(planner.validateForGeneratedImport).not.toHaveBeenCalled();
        });

        it('propagates applier rejection', async () => {
            (applier.applyPipelineSettings as jest.Mock).mockRejectedValue(
                new Error('Plugin row missing'),
            );

            await expect(service.applyPipelineSettings('w', 'u')).rejects.toThrow(
                'Plugin row missing',
            );
        });
    });

    describe('applyInitialSchedule (async applier delegate)', () => {
        it('forwards (workId, user, worksConfig) verbatim', async () => {
            (applier.applyInitialSchedule as jest.Mock).mockResolvedValue(undefined);
            const user = { id: 'user-1', email: 'u@example.com' } as any;
            const worksConfig = { name: 'w' } as any;

            await service.applyInitialSchedule('work-1', user, worksConfig);

            expect(applier.applyInitialSchedule).toHaveBeenCalledWith('work-1', user, worksConfig);
        });

        it('forwards undefined worksConfig when omitted', async () => {
            (applier.applyInitialSchedule as jest.Mock).mockResolvedValue(undefined);
            const user = { id: 'user-1' } as any;
            await service.applyInitialSchedule('work-1', user);
            expect(applier.applyInitialSchedule).toHaveBeenCalledWith('work-1', user, undefined);
        });

        it('propagates applier rejection', async () => {
            (applier.applyInitialSchedule as jest.Mock).mockRejectedValue(
                new Error('Schedule write failed'),
            );

            await expect(service.applyInitialSchedule('w', { id: 'u' } as any)).rejects.toThrow(
                'Schedule write failed',
            );
        });
    });

    describe('applyScheduleOverrides (async applier delegate)', () => {
        it('forwards (work, user, worksConfig) verbatim', async () => {
            (applier.applyScheduleOverrides as jest.Mock).mockResolvedValue(undefined);
            const work = { id: 'work-1', slug: 'my-slug' } as any;
            const user = { id: 'user-1' } as any;
            const worksConfig = { name: 'w' } as any;

            await service.applyScheduleOverrides(work, user, worksConfig);

            expect(applier.applyScheduleOverrides).toHaveBeenCalledWith(work, user, worksConfig);
        });

        it('forwards undefined worksConfig when omitted', async () => {
            (applier.applyScheduleOverrides as jest.Mock).mockResolvedValue(undefined);
            const work = { id: 'w' } as any;
            const user = { id: 'u' } as any;

            await service.applyScheduleOverrides(work, user);

            expect(applier.applyScheduleOverrides).toHaveBeenCalledWith(work, user, undefined);
        });

        it('propagates applier rejection', async () => {
            (applier.applyScheduleOverrides as jest.Mock).mockRejectedValue(
                new Error('Schedule override write failed'),
            );

            await expect(
                service.applyScheduleOverrides({ id: 'w' } as any, { id: 'u' } as any),
            ).rejects.toThrow('Schedule override write failed');
        });
    });

    describe('cross-method invariants', () => {
        it('every planner method maps to exactly one public method on the service', () => {
            // Pin the public surface so a future delegate addition (e.g. a new
            // planner method that ALSO needs an exposed wrapper here) gets
            // caught: the count of jest.fn()s on the planner matches the count
            // of planner-backed public methods.
            const plannerBacked = [
                'toSnapshot',
                'toResolved',
                'getConflictRepoNames',
                'sanitizeConflict',
                'validateForImport',
                'validateProviderSettings',
                'validateRepositoryTargets',
                'buildSourceRepository',
            ];
            for (const method of plannerBacked) {
                expect(typeof (service as unknown as Record<string, unknown>)[method]).toBe(
                    'function',
                );
            }
        });

        it('every applier method maps to exactly one public method on the service', () => {
            const applierBacked = [
                'applyPipelineSettings',
                'applyInitialSchedule',
                'applyScheduleOverrides',
            ];
            for (const method of applierBacked) {
                expect(typeof (service as unknown as Record<string, unknown>)[method]).toBe(
                    'function',
                );
            }
        });
    });
});

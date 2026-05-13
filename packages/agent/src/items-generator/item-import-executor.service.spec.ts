// Hoisted module mocks. DataRepository pulls in fs + isomorphic-git, so we
// stub it before the SUT import (same approach as
// `item-submission.service.spec.ts`). `p-map` v7 is ESM-only, which Jest can't
// load through `ts-jest` — replace it with a sequential async iterator. The
// behavior we care about (per-row dispatch, error capture, ordering) is
// identical between sequential and parallel modes.
jest.mock('../generators/data-generator/data-repository', () => ({
    DataRepository: { create: jest.fn() },
}));
jest.mock('p-map', () => ({
    __esModule: true,
    default: async <T, R>(
        iterable: Iterable<T>,
        mapper: (item: T, index: number) => Promise<R>,
    ): Promise<R[]> => {
        const results: R[] = [];
        let index = 0;
        for (const item of iterable) {
            results.push(await mapper(item, index));
            index += 1;
        }
        return results;
    },
}));

import { ItemImportExecutorService } from './item-import-executor.service';
import { ItemImportService } from './item-import.service';
import { DataRepository } from '../generators/data-generator/data-repository';
import type { ImportRowValidation } from './item-import-export.types';

const dataRepoCreateMock = DataRepository.create as jest.Mock;

// Real ItemImportService — its revalidateImportRowData is pure logic over
// canonical-shape row data and exercises the same field validators as the
// /validate endpoint. Sharing the instance across tests is fine.
const itemImportService = new ItemImportService();

interface WorkLike {
    id: string;
    slug: string;
    user: { id: string };
    gitProvider: string;
    getDataRepo: jest.Mock;
    getRepoOwner: jest.Mock;
    resolveCommitter: jest.Mock;
}

function makeWork(): WorkLike {
    return {
        id: 'work-1',
        slug: 'best-tools',
        user: { id: 'owner-1' },
        gitProvider: 'github',
        getDataRepo: jest.fn().mockReturnValue('best-tools-data'),
        getRepoOwner: jest.fn().mockReturnValue('acme'),
        resolveCommitter: jest.fn().mockReturnValue({ name: 'Octo', email: 'o@e.com' }),
    };
}

function makeGitFacade() {
    return {
        cloneOrPull: jest.fn().mockResolvedValue('/tmp/work-1/data'),
        getMainBranch: jest.fn().mockResolvedValue('main'),
        switchBranch: jest.fn((_p: string, _d: string, branch: string) => Promise.resolve(branch)),
        add: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue('sha-1'),
        push: jest.fn().mockResolvedValue(undefined),
        createPullRequest: jest.fn().mockResolvedValue({
            number: 42,
            url: 'https://github.com/acme/best-tools-data/pull/42',
        }),
    };
}

function makeDataRepo(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return {
        getConfig: jest.fn().mockResolvedValue({ autoapproval: false }),
        getItems: jest.fn().mockResolvedValue([]),
        createItemDir: jest.fn().mockResolvedValue(undefined),
        writeItem: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function row(
    rowIndex: number,
    data: Record<string, unknown>,
    extra: Partial<ImportRowValidation> = {},
): ImportRowValidation {
    return {
        rowIndex,
        valid: true,
        errors: [],
        warnings: [],
        data: {
            name: `Row ${rowIndex}`,
            description: `Description ${rowIndex}`,
            source_url: `https://row-${rowIndex}.test`,
            category: 'Tools',
            ...data,
        } as ImportRowValidation['data'],
        ...extra,
    };
}

describe('ItemImportExecutorService', () => {
    beforeEach(() => {
        dataRepoCreateMock.mockReset();
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-05-12T12:00:00Z'));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('writes all valid rows + single commit + push, opens a PR when autoapproval is false', async () => {
        const work = makeWork();
        const user = { id: 'u-1' };
        const git = makeGitFacade();
        const repo = makeDataRepo();
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        const result = await service.executeImport(work as any, user as any, {
            rows: [row(0, { name: 'A' }), row(1, { name: 'B' })],
            duplicate_strategy: 'skip',
        });

        expect(repo.createItemDir).toHaveBeenCalledTimes(2);
        expect(repo.writeItem).toHaveBeenCalledTimes(2);
        expect(git.add).toHaveBeenCalledTimes(1);
        expect(git.commit).toHaveBeenCalledTimes(1);
        expect(git.push).toHaveBeenCalledTimes(1);
        expect(git.createPullRequest).toHaveBeenCalledTimes(1);
        expect(git.switchBranch).toHaveBeenCalledWith(
            'github',
            '/tmp/work-1/data',
            expect.stringMatching(/^items-import-\d+$/),
            true,
        );
        expect(result.created).toBe(2);
        expect(result.updated).toBe(0);
        expect(result.skipped).toBe(0);
        expect(result.errors).toHaveLength(0);
        expect(result.pr_number).toBe(42);
        expect(result.pr_url).toContain('pull/42');
    });

    it('direct-commits to main when autoapproval is true (no PR)', async () => {
        const work = makeWork();
        const git = makeGitFacade();
        const repo = makeDataRepo({
            getConfig: jest.fn().mockResolvedValue({ autoapproval: true }),
        });
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        const result = await service.executeImport(work as any, { id: 'u-1' } as any, {
            rows: [row(0, { name: 'A' })],
            duplicate_strategy: 'skip',
        });

        expect(git.switchBranch).toHaveBeenCalledWith('github', '/tmp/work-1/data', 'main');
        expect(git.createPullRequest).not.toHaveBeenCalled();
        expect(result.direct_commit).toBe(true);
        expect(result.pr_number).toBeUndefined();
    });

    it("skips duplicates when strategy is 'skip' (matched by slug)", async () => {
        const work = makeWork();
        const git = makeGitFacade();
        const repo = makeDataRepo({
            getItems: jest
                .fn()
                .mockResolvedValue([{ slug: 'row-0', source_url: 'https://row-0.test' }]),
        });
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        const result = await service.executeImport(work as any, { id: 'u-1' } as any, {
            rows: [
                row(0, { name: 'Row 0', slug: 'row-0' }),
                row(1, { name: 'Row 1', slug: 'row-1' }),
            ],
            duplicate_strategy: 'skip',
        });

        expect(repo.createItemDir).toHaveBeenCalledTimes(1);
        expect(result.created).toBe(1);
        expect(result.skipped).toBe(1);
    });

    it("overwrites duplicates when strategy is 'update' (writeItem only, no createItemDir)", async () => {
        const work = makeWork();
        const git = makeGitFacade();
        const repo = makeDataRepo({
            getItems: jest
                .fn()
                .mockResolvedValue([{ slug: 'row-0', source_url: 'https://row-0.test' }]),
        });
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        const result = await service.executeImport(work as any, { id: 'u-1' } as any, {
            rows: [row(0, { name: 'Row 0', slug: 'row-0' })],
            duplicate_strategy: 'update',
        });

        expect(repo.createItemDir).not.toHaveBeenCalled();
        expect(repo.writeItem).toHaveBeenCalledTimes(1);
        expect(result.updated).toBe(1);
        expect(result.created).toBe(0);
    });

    it("rewrites slug to existing item's when matched only by source_url ('update' strategy)", async () => {
        const work = makeWork();
        const git = makeGitFacade();
        const repo = makeDataRepo({
            getItems: jest
                .fn()
                .mockResolvedValue([
                    { slug: 'existing-tool', source_url: 'https://shared.test/x' },
                ]),
        });
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        // Incoming row's slug ('incoming-tool') differs from the existing
        // item's slug ('existing-tool'), but their source_url matches.
        // writeItem must target 'existing-tool' — otherwise the update
        // hits a non-existent directory because updates skip createItemDir.
        await service.executeImport(work as any, { id: 'u-1' } as any, {
            rows: [
                row(0, {
                    name: 'Incoming Tool',
                    slug: 'incoming-tool',
                    source_url: 'https://shared.test/x',
                }),
            ],
            duplicate_strategy: 'update',
        });

        expect(repo.createItemDir).not.toHaveBeenCalled();
        expect(repo.writeItem).toHaveBeenCalledTimes(1);
        const writeArg = (repo.writeItem as jest.Mock).mock.calls[0][0];
        expect(writeArg.slug).toBe('existing-tool');
        expect(writeArg.source_url).toBe('https://shared.test/x');
    });

    it('collects per-row errors without aborting the batch and still commits the successes', async () => {
        const work = makeWork();
        const git = makeGitFacade();
        const repo = makeDataRepo({
            writeItem: jest
                .fn()
                .mockImplementationOnce(() => Promise.reject(new Error('disk full')))
                .mockResolvedValueOnce(undefined),
        });
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        const result = await service.executeImport(work as any, { id: 'u-1' } as any, {
            rows: [row(0, { name: 'Boom' }), row(1, { name: 'OK' })],
            duplicate_strategy: 'skip',
        });

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].rowIndex).toBe(0);
        expect(result.errors[0].message).toMatch(/disk full/);
        expect(result.created).toBe(1);
        expect(git.commit).toHaveBeenCalledTimes(1);
    });

    it('skips commit/push when nothing was written', async () => {
        const work = makeWork();
        const git = makeGitFacade();
        const repo = makeDataRepo({
            writeItem: jest.fn().mockRejectedValue(new Error('always fails')),
        });
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        const result = await service.executeImport(work as any, { id: 'u-1' } as any, {
            rows: [row(0, { name: 'A' })],
            duplicate_strategy: 'skip',
        });

        expect(git.add).not.toHaveBeenCalled();
        expect(git.commit).not.toHaveBeenCalled();
        expect(git.push).not.toHaveBeenCalled();
        expect(git.createPullRequest).not.toHaveBeenCalled();
        expect(result.created).toBe(0);
        expect(result.errors).toHaveLength(1);
    });

    it('ignores invalid rows passed in the input array', async () => {
        const work = makeWork();
        const git = makeGitFacade();
        const repo = makeDataRepo();
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        const result = await service.executeImport(work as any, { id: 'u-1' } as any, {
            rows: [
                row(0, { name: 'OK' }),
                {
                    rowIndex: 1,
                    valid: false,
                    errors: ['bad'],
                    warnings: [],
                    data: undefined,
                },
            ],
            duplicate_strategy: 'skip',
        });

        expect(repo.writeItem).toHaveBeenCalledTimes(1);
        expect(result.created).toBe(1);
    });

    it("detects intra-batch slug collisions from name-derived slugs (skip strategy doesn't double-write)", async () => {
        // Both rows have the same name and no explicit slug — the executor
        // derives slug='same-name' for both. Without the planning pass, the
        // second writeItem would silently overwrite the first under
        // concurrency=5. With the planning pass, the second is classified as
        // a duplicate and skipped.
        const work = makeWork();
        const git = makeGitFacade();
        const repo = makeDataRepo();
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        const result = await service.executeImport(work as any, { id: 'u-1' } as any, {
            rows: [
                row(0, {
                    name: 'Same Name',
                    description: 'd',
                    source_url: 'https://a.test',
                    category: 'Tools',
                }),
                row(1, {
                    name: 'Same Name',
                    description: 'd',
                    source_url: 'https://b.test',
                    category: 'Tools',
                }),
            ],
            duplicate_strategy: 'skip',
        });

        expect(repo.createItemDir).toHaveBeenCalledTimes(1);
        expect(repo.writeItem).toHaveBeenCalledTimes(1);
        expect(result.created).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.errors).toHaveLength(0);
    });

    it('on `update` strategy, name-derived collisions write twice (create + update) without two creates', async () => {
        const work = makeWork();
        const git = makeGitFacade();
        const repo = makeDataRepo();
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        const result = await service.executeImport(work as any, { id: 'u-1' } as any, {
            rows: [
                row(0, {
                    name: 'Same Name',
                    description: 'd',
                    source_url: 'https://a.test',
                    category: 'Tools',
                }),
                row(1, {
                    name: 'Same Name',
                    description: 'd',
                    source_url: 'https://b.test',
                    category: 'Tools',
                }),
            ],
            duplicate_strategy: 'update',
        });

        // First row creates a fresh item directory; the second is treated as
        // an update (writeItem only). No second createItemDir = no silent
        // overwrite of a freshly-created sibling.
        expect(repo.createItemDir).toHaveBeenCalledTimes(1);
        expect(repo.writeItem).toHaveBeenCalledTimes(2);
        expect(result.created).toBe(1);
        expect(result.updated).toBe(1);
    });

    it('rejects rows that pass `valid: true` but fail server-side revalidation (tamper guard)', async () => {
        const work = makeWork();
        const git = makeGitFacade();
        const repo = makeDataRepo();
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        // Row 0: client claims valid but source_url is not http(s) — rejected.
        // Row 1: client claims valid but missing required `description` — rejected.
        // Row 2: legitimately valid — written.
        const result = await service.executeImport(work as any, { id: 'u-1' } as any, {
            rows: [
                {
                    rowIndex: 0,
                    valid: true,
                    errors: [],
                    warnings: [],
                    data: {
                        name: 'Tampered',
                        description: 'd',
                        source_url: 'javascript:alert(1)',
                        category: 'Tools',
                    } as any,
                },
                {
                    rowIndex: 1,
                    valid: true,
                    errors: [],
                    warnings: [],
                    data: {
                        name: 'Missing description',
                        source_url: 'https://r1.test',
                        category: 'Tools',
                    } as any,
                },
                row(2, { name: 'Legit' }),
            ],
            duplicate_strategy: 'skip',
        });

        expect(repo.writeItem).toHaveBeenCalledTimes(1);
        expect(result.created).toBe(1);
        expect(result.errors).toHaveLength(2);
        expect(result.errors[0].message).toMatch(/Server-side validation failed/);
        expect(result.errors[0].message).toMatch(/source_url/);
        expect(result.errors[1].message).toMatch(/Server-side validation failed/);
        expect(result.errors[1].message).toMatch(/description/);
    });

    it('strips unknown fields from row.data during revalidation (no path-traversal in extra keys)', async () => {
        const work = makeWork();
        const git = makeGitFacade();
        const repo = makeDataRepo();
        dataRepoCreateMock.mockResolvedValue(repo);
        const service = new ItemImportExecutorService(git as any, itemImportService);

        const result = await service.executeImport(work as any, { id: 'u-1' } as any, {
            rows: [
                {
                    rowIndex: 0,
                    valid: true,
                    errors: [],
                    warnings: [],
                    data: {
                        name: 'OK',
                        description: 'd',
                        source_url: 'https://ok.test',
                        category: 'Tools',
                        // Unknown attribute the wizard would never emit —
                        // must not reach writeItem.
                        __proto__: { admin: true },
                        rogue_field: '../../etc/passwd',
                    } as any,
                },
            ],
            duplicate_strategy: 'skip',
        });

        expect(result.created).toBe(1);
        const writtenItem = (repo.writeItem as jest.Mock).mock.calls[0][0];
        expect(writtenItem).not.toHaveProperty('rogue_field');
        expect(writtenItem.name).toBe('OK');
    });
});

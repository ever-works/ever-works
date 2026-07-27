// Hoisted module mocks — same posture as
// `item-import-executor.service.spec.ts`: DataRepository pulls in fs +
// isomorphic-git, and `p-map` v7 is ESM-only, which Jest can't load through
// the CJS transform.
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

/**
 * Quality gates (audit W3 M3) — the CSV/Excel bulk import is one of the
 * non-worker `createPullRequest` callers. The rows are written, committed
 * and pushed on the import branch either way; the gate decides whether that
 * branch may be proposed for merge.
 */

const dataRepoCreateMock = DataRepository.create as jest.Mock;
const itemImportService = new ItemImportService();

function makeWork() {
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

function makeDataRepo() {
    return {
        getConfig: jest.fn().mockResolvedValue({ autoapproval: false }),
        getItems: jest.fn().mockResolvedValue([]),
        createItemDir: jest.fn().mockResolvedValue(undefined),
        writeItem: jest.fn().mockResolvedValue(undefined),
    };
}

function row(rowIndex: number, name: string): ImportRowValidation {
    return {
        rowIndex,
        valid: true,
        errors: [],
        warnings: [],
        data: {
            name,
            description: `Description ${rowIndex}`,
            source_url: `https://row-${rowIndex}.test`,
            category: 'Tools',
        } as ImportRowValidation['data'],
    };
}

const allowingGate = () => ({
    evaluate: jest.fn().mockResolvedValue({
        allowed: true,
        policy: 'required',
        gateStatus: 'green',
        results: [],
    }),
});

const refusingGate = () => ({
    evaluate: jest.fn().mockResolvedValue({
        allowed: false,
        policy: 'required',
        gateStatus: 'red',
        results: [],
        reason: 'Quality gate red — failing required checks: build (red).',
    }),
});

describe('ItemImportExecutorService — pull-request quality gate', () => {
    beforeEach(() => {
        dataRepoCreateMock.mockReset();
        dataRepoCreateMock.mockResolvedValue(makeDataRepo());
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-05-12T12:00:00Z'));
    });

    afterEach(() => jest.useRealTimers());

    const run = async (gate?: unknown) => {
        const git = makeGitFacade();
        const service = new ItemImportExecutorService(
            git as never,
            itemImportService,
            gate as never,
        );
        const result = await service.executeImport(makeWork() as never, { id: 'u-1' } as never, {
            rows: [row(0, 'A'), row(1, 'B')],
            duplicate_strategy: 'skip',
        });
        return { git, result };
    };

    it('gate passes → the PR is opened, judged against the cloned checkout', async () => {
        const git = makeGitFacade();
        const gate = allowingGate();
        const service = new ItemImportExecutorService(
            git as never,
            itemImportService,
            gate as never,
        );

        const result = await service.executeImport(makeWork() as never, { id: 'u-1' } as never, {
            rows: [row(0, 'A')],
            duplicate_strategy: 'skip',
        });

        expect(gate.evaluate).toHaveBeenCalledWith(
            expect.objectContaining({ cwd: '/tmp/work-1/data' }),
        );
        expect(git.createPullRequest).toHaveBeenCalledTimes(1);
        expect(result.pr_number).toBe(42);
        expect(result.pr_withheld_reason).toBeUndefined();
    });

    it('gate fails → NO PR is opened, the rows still land, and the reason is surfaced', async () => {
        const { git, result } = await run(refusingGate());

        expect(git.createPullRequest).not.toHaveBeenCalled();
        // The write + commit + push half of the import is unaffected — only
        // the pull request is withheld.
        expect(git.commit).toHaveBeenCalledTimes(1);
        expect(git.push).toHaveBeenCalledTimes(1);
        expect(result.created).toBe(2);
        expect(result.pr_number).toBeUndefined();
        expect(result.pr_url).toBeUndefined();
        expect(result.pr_withheld_reason).toContain('build (red)');
    });

    it('no gate wired → unchanged pre-gate behaviour', async () => {
        const { git, result } = await run(undefined);

        expect(git.createPullRequest).toHaveBeenCalledTimes(1);
        expect(result.pr_number).toBe(42);
        expect(result.pr_withheld_reason).toBeUndefined();
    });
});

// Hoisted module mocks. The data-repository factory wraps `fs-extra` +
// `isomorphic-git`, so any spec that exercises `ItemSubmissionService` MUST
// stub it before the SUT import — otherwise the import graph pulls real disk
// + git operations into Jest. Same posture as
// `item-submission.service.spec.ts`.
jest.mock('../generators/data-generator/data-repository', () => ({
    DataRepository: { create: jest.fn() },
}));

import { ItemSubmissionService } from './item-submission.service';
import { DataRepository } from '../generators/data-generator/data-repository';

/**
 * Quality gates (audit W3 M3) — `createPullRequest` was ungated outside the
 * worker. `ItemSubmissionService` owns three of those call sites (submit /
 * remove / update), so each one must consult `PullRequestGateService` and
 * refuse to open a PR on a failing verdict.
 *
 * The gate itself is stubbed here: its own decision table (policy `off` /
 * `warn` / `required` × green / red / skipped) is covered by
 * `policy/__tests__/pull-request-gate.service.spec.ts` against REAL
 * subprocesses. What these tests pin is the WIRING — that the caller asks,
 * and that it honours the answer.
 */

const dataRepoCreateMock = DataRepository.create as jest.Mock;

function makeWork() {
    return {
        id: 'work-1',
        slug: 'best-tools',
        user: { id: 'owner-1', username: 'octocat', email: 'octo@example.com' },
        gitProvider: 'github',
        getDataRepo: jest.fn().mockReturnValue('best-tools-data'),
        getRepoOwner: jest.fn().mockReturnValue('acme'),
        resolveCommitter: jest.fn().mockReturnValue({ name: 'Octo', email: 'octo@example.com' }),
    };
}

function makeUser() {
    return { id: 'submitter-1', username: 'submitter', email: 'submitter@example.com' };
}

function makeGitFacade() {
    return {
        cloneOrPull: jest.fn().mockResolvedValue('/tmp/work-1/data'),
        getMainBranch: jest.fn().mockResolvedValue('main'),
        switchBranch: jest.fn(async (_p: string, _d: string, branch: string) => branch),
        add: jest.fn().mockResolvedValue(undefined),
        addAll: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue('sha-1'),
        push: jest.fn().mockResolvedValue(undefined),
        createPullRequest: jest.fn().mockResolvedValue({
            number: 7,
            url: 'https://github.com/acme/best-tools-data/pull/7',
        }),
    };
}

function makeScreenshotFacade() {
    return { isAvailable: jest.fn().mockReturnValue(false), capture: jest.fn() };
}

function makeDataRepo(overrides: Record<string, jest.Mock> = {}) {
    return {
        getConfig: jest.fn().mockResolvedValue({ autoapproval: false }),
        createItemDir: jest.fn().mockResolvedValue(undefined),
        writeItem: jest.fn().mockResolvedValue(undefined),
        writeItemMarkdown: jest.fn().mockResolvedValue(undefined),
        itemExists: jest.fn().mockResolvedValue(true),
        getItem: jest.fn(),
        removeItem: jest.fn().mockResolvedValue(true),
        updateItemMetadata: jest.fn(),
        ...overrides,
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

function makeService(gate?: unknown, gitFacade = makeGitFacade()) {
    const service = new ItemSubmissionService(
        gitFacade as never,
        makeScreenshotFacade() as never,
        gate as never,
    );
    return { service, gitFacade };
}

const SUBMIT_DTO = {
    name: 'Tool A',
    description: 'desc',
    source_url: 'https://example.com',
    category: 'AI',
};

describe('ItemSubmissionService — pull-request quality gate', () => {
    beforeEach(() => {
        dataRepoCreateMock.mockReset();
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-05-08T12:00:00Z'));
    });

    afterEach(() => jest.useRealTimers());

    describe('submitItem', () => {
        it('gate passes → the PR is opened, against the cloned checkout', async () => {
            dataRepoCreateMock.mockResolvedValue(makeDataRepo());
            const gate = allowingGate();
            const { service, gitFacade } = makeService(gate);

            const result = await service.submitItem(
                makeWork() as never,
                makeUser() as never,
                SUBMIT_DTO as never,
            );

            expect(gate.evaluate).toHaveBeenCalledWith(
                expect.objectContaining({ cwd: '/tmp/work-1/data' }),
            );
            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
            expect(result.status).toBe('success');
            expect(result.pr_number).toBe(7);
        });

        it('gate fails → NO PR is opened and the failure is surfaced to the caller', async () => {
            dataRepoCreateMock.mockResolvedValue(makeDataRepo());
            const { service, gitFacade } = makeService(refusingGate());

            const result = await service.submitItem(
                makeWork() as never,
                makeUser() as never,
                SUBMIT_DTO as never,
            );

            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(result.status).toBe('error');
            expect(result.pr_number).toBeUndefined();
            expect(result.message).toContain('build (red)');
            // The commit + push already happened, so the message must not
            // imply the submission was lost.
            expect(gitFacade.push).toHaveBeenCalled();
            expect(result.message).toContain('committed');
        });

        it('no gate wired at all → unchanged pre-gate behaviour', async () => {
            dataRepoCreateMock.mockResolvedValue(makeDataRepo());
            const { service, gitFacade } = makeService(undefined);

            const result = await service.submitItem(
                makeWork() as never,
                makeUser() as never,
                SUBMIT_DTO as never,
            );

            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
            expect(result.status).toBe('success');
            expect(result.pr_number).toBe(7);
        });

        it('the direct-commit path never consults the gate (there is no PR to withhold)', async () => {
            dataRepoCreateMock.mockResolvedValue(
                makeDataRepo({ getConfig: jest.fn().mockResolvedValue({ autoapproval: true }) }),
            );
            const gate = refusingGate();
            const { service, gitFacade } = makeService(gate);

            const result = await service.submitItem(
                makeWork() as never,
                makeUser() as never,
                SUBMIT_DTO as never,
            );

            expect(gate.evaluate).not.toHaveBeenCalled();
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(result.status).toBe('success');
            expect(result.direct_commit).toBe(true);
        });
    });

    describe('removeItem', () => {
        const removableRepo = () =>
            makeDataRepo({
                getItem: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    category: 'AI',
                }),
            });

        it('gate passes → the PR is opened', async () => {
            dataRepoCreateMock.mockResolvedValue(removableRepo());
            const { service, gitFacade } = makeService(allowingGate());

            const result = await service.removeItem(
                makeWork() as never,
                makeUser() as never,
                {
                    item_slug: 'tool-a',
                    create_pull_request: true,
                } as never,
            );

            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
            expect(result.status).toBe('success');
        });

        it('gate fails → NO PR is opened and the failure is surfaced', async () => {
            dataRepoCreateMock.mockResolvedValue(removableRepo());
            const { service, gitFacade } = makeService(refusingGate());

            const result = await service.removeItem(
                makeWork() as never,
                makeUser() as never,
                {
                    item_slug: 'tool-a',
                    create_pull_request: true,
                } as never,
            );

            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(result.status).toBe('error');
            expect(result.message).toContain('build (red)');
        });

        it('no gate wired → unchanged pre-gate behaviour', async () => {
            dataRepoCreateMock.mockResolvedValue(removableRepo());
            const { service, gitFacade } = makeService(undefined);

            const result = await service.removeItem(
                makeWork() as never,
                makeUser() as never,
                {
                    item_slug: 'tool-a',
                    create_pull_request: true,
                } as never,
            );

            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
            expect(result.status).toBe('success');
        });
    });

    describe('updateItem', () => {
        const updatableRepo = () =>
            makeDataRepo({
                getItem: jest
                    .fn()
                    .mockResolvedValue({ name: 'Tool A', source_url: 'https://example.com' }),
                updateItemMetadata: jest.fn().mockResolvedValue({
                    name: 'Tool A',
                    source_url: 'https://example.com',
                    featured: true,
                }),
            });

        it('gate passes → the PR is opened', async () => {
            dataRepoCreateMock.mockResolvedValue(updatableRepo());
            const { service, gitFacade } = makeService(allowingGate());

            const result = await service.updateItem(
                makeWork() as never,
                makeUser() as never,
                {
                    item_slug: 'tool-a',
                    featured: true,
                    create_pull_request: true,
                } as never,
            );

            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
            expect(result.status).toBe('success');
        });

        it('gate fails → NO PR is opened and the failure is surfaced', async () => {
            dataRepoCreateMock.mockResolvedValue(updatableRepo());
            const { service, gitFacade } = makeService(refusingGate());

            const result = await service.updateItem(
                makeWork() as never,
                makeUser() as never,
                {
                    item_slug: 'tool-a',
                    featured: true,
                    create_pull_request: true,
                } as never,
            );

            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(result.status).toBe('error');
            expect(result.message).toContain('build (red)');
        });

        it('no gate wired → unchanged pre-gate behaviour', async () => {
            dataRepoCreateMock.mockResolvedValue(updatableRepo());
            const { service, gitFacade } = makeService(undefined);

            const result = await service.updateItem(
                makeWork() as never,
                makeUser() as never,
                {
                    item_slug: 'tool-a',
                    featured: true,
                    create_pull_request: true,
                } as never,
            );

            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
            expect(result.status).toBe('success');
        });
    });
});

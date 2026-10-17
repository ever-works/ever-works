jest.mock('@ever-works/agent/app-builds', () => ({
    AppBuildsService: class AppBuildsService {},
}));
jest.mock('@ever-works/agent/database', () => ({
    AppBuildPreparationRepository: class AppBuildPreparationRepository {},
    WorkRepository: class WorkRepository {},
}));
jest.mock('@ever-works/agent/config', () => ({
    config: { everWorks: { apps: { worksEnabled: jest.fn(() => true) } } },
}));
// The dispatcher module pulls the GitHub App sync graph; the consumer only needs
// the class as a lookup token.
jest.mock('../ingest/github/github-webhook-dispatcher.service', () => ({
    GitHubWebhookDispatcherService: class GitHubWebhookDispatcherService {},
}));

import { config } from '@ever-works/agent/config';
import { APP_BUILD_WORKFLOW_PATH } from '@ever-works/contracts';
import {
    AppBuildWorkflowRunConsumer,
    isBuildWorkflowPath,
} from './app-build-workflow-run.consumer';

/**
 * APW-05 T24 — the `workflow_run` consumer (plan §7.5).
 *
 * The accept rules themselves (strategy gate, fork-PR rule, manual adoption, the
 * single `app.build.queued`) are `AppBuildsService.recordProviderRun`'s and have
 * their own spec; this one proves the consumer filters, maps and hands over —
 * and that it never makes an outbound call of its own (every collaborator is a
 * double, and none of them is an HTTP client).
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);
const BINDING = { userId: USER_ID, webhookSecret: 'x', matchedBy: 'app-install' } as never;

const worksEnabled = (config as unknown as { everWorks: { apps: { worksEnabled: jest.Mock } } })
    .everWorks.apps.worksEnabled;

function body(run: Record<string, unknown> = {}, fullName = 'Acme/App') {
    return {
        action: 'requested',
        repository: { full_name: fullName },
        workflow_run: {
            id: 9001,
            run_attempt: 1,
            event: 'push',
            status: 'queued',
            head_sha: SHA,
            head_branch: 'main',
            head_repository: { full_name: fullName },
            display_title: 'chore: bump',
            created_at: '2026-10-17T10:00:00Z',
            path: APP_BUILD_WORKFLOW_PATH,
            ...run,
        },
    } as never;
}

function harness(options: { works?: unknown[]; workflowState?: string } = {}) {
    const works = {
        findAppWorksByDataRepository: jest.fn(async () => options.works ?? [{ id: WORK_ID }]),
    };
    const builds = {
        recordProviderRun: jest.fn(async () => ({
            accepted: true,
            build: { id: 'b1' },
            created: true,
        })),
        requestPrepare: jest.fn(async () => ({ prepareSeq: 1, dispatched: true })),
    };
    const preparations = {
        findByWork: jest.fn(async () =>
            options.workflowState ? { workflowState: options.workflowState } : null,
        ),
    };
    const dispatcher = { registerConsumer: jest.fn() };
    const moduleRef = { get: jest.fn(() => dispatcher) };
    const consumer = new AppBuildWorkflowRunConsumer(
        moduleRef as never,
        works as never,
        builds as never,
        preparations as never,
    );
    return { consumer, works, builds, preparations, dispatcher, moduleRef };
}

describe('AppBuildWorkflowRunConsumer (APW-05 T24)', () => {
    beforeEach(() => worksEnabled.mockReturnValue(true));

    it('registers itself on the ingest dispatcher for workflow_run', () => {
        const h = harness();
        h.consumer.onModuleInit();
        expect(h.dispatcher.registerConsumer).toHaveBeenCalledWith(h.consumer);
        expect(h.consumer.events).toEqual(['workflow_run']);
    });

    it('registers nothing, and does not throw, when the process has no dispatcher', () => {
        const h = harness();
        h.moduleRef.get.mockImplementation(() => {
            throw new Error('unknown element');
        });
        expect(() => h.consumer.onModuleInit()).not.toThrow();
    });

    it('records a push run of the build workflow through recordProviderRun(…, "event")', async () => {
        const h = harness();
        const answer = await h.consumer.handle(BINDING, 'workflow_run', body());

        expect(answer).toEqual({ recorded: 1 });
        expect(h.works.findAppWorksByDataRepository).toHaveBeenCalledWith(USER_ID, 'Acme', 'App');
        expect(h.builds.recordProviderRun).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({
                providerRunId: '9001',
                event: 'push',
                status: 'queued',
                headSha: SHA,
                headRepositoryFullName: 'Acme/App',
            }),
            'event',
        );
    });

    it('ignores other workflow paths, other events, unknown repositories and the switch off', async () => {
        const h = harness();
        expect(
            await h.consumer.handle(
                BINDING,
                'workflow_run',
                body({ path: '.github/workflows/ci.yml' }),
            ),
        ).toEqual({ recorded: 0, ignored: 'workflowPath' });
        expect(await h.consumer.handle(BINDING, 'check_run', body())).toEqual({
            recorded: 0,
            ignored: 'event',
        });

        const none = harness({ works: [] });
        expect(await none.consumer.handle(BINDING, 'workflow_run', body())).toEqual({
            recorded: 0,
            ignored: 'notAppWork',
        });

        worksEnabled.mockReturnValue(false);
        expect(await h.consumer.handle(BINDING, 'workflow_run', body())).toEqual({
            recorded: 0,
            ignored: 'disabled',
        });
        expect(h.builds.recordProviderRun).not.toHaveBeenCalled();
    });

    it('hands a fork pull-request run over with its head repository, for the shared fork rule to refuse', async () => {
        const h = harness();
        h.builds.recordProviderRun.mockResolvedValueOnce({
            accepted: false,
            reason: 'forkPullRequestHead',
        } as never);
        const answer = await h.consumer.handle(
            BINDING,
            'workflow_run',
            body({
                event: 'pull_request',
                head_repository: { full_name: 'stranger/App' },
                pull_requests: [{ number: 7 }],
            }),
        );
        expect(answer).toEqual({ recorded: 0 });
        expect(h.builds.recordProviderRun).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({
                event: 'pull_request',
                headRepositoryFullName: 'stranger/App',
                pullRequestNumber: 7,
            }),
            'event',
        );
    });

    it('maps a platform dispatch (workflow_dispatch) onto the manual adoption path', async () => {
        const h = harness();
        await h.consumer.handle(
            BINDING,
            'workflow_run',
            body({ event: 'workflow_dispatch', display_title: 'Ever Works build b-1' }),
        );
        expect(h.builds.recordProviderRun).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({ event: 'manual', displayTitle: 'Ever Works build b-1' }),
            'event',
        );
    });

    it('asks for a workflowMerged prepare on a push while the workflow pull request is open', async () => {
        const open = harness({ workflowState: 'pullRequestOpen' });
        await open.consumer.handle(BINDING, 'workflow_run', body());
        expect(open.builds.requestPrepare).toHaveBeenCalledWith(WORK_ID, 'workflowMerged');

        const committed = harness({ workflowState: 'committed' });
        await committed.consumer.handle(BINDING, 'workflow_run', body());
        expect(committed.builds.requestPrepare).not.toHaveBeenCalled();
    });

    it('accepts a workflow path with an @ref suffix, and nothing else', () => {
        expect(isBuildWorkflowPath(APP_BUILD_WORKFLOW_PATH)).toBe(true);
        expect(isBuildWorkflowPath(`${APP_BUILD_WORKFLOW_PATH}@refs/heads/main`)).toBe(true);
        expect(isBuildWorkflowPath('.github/workflows/ever-works-build.yaml')).toBe(false);
        expect(isBuildWorkflowPath(undefined)).toBe(false);
    });
});

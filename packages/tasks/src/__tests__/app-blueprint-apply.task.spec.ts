import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * APW-03 T28 (lane aw-blueprints) — **`app-blueprint-apply`**, one Blueprint apply or
 * upgrade of one App Work.
 *
 * Pinned: the registration (plan §6.1's id and 300 s budget, equal to the API-side job
 * id the dispatcher enqueues under), the RPC seam (the worker proxies exactly the name
 * `TriggerInternalController.remoteMap` publishes, `AppBlueprintApplyRunner`), and the
 * named refusals — a missing seam, an unusable payload and a rejecting RPC are never a
 * green result.
 */

const { recorded, createRemoteProxyMock, loggerErrorMock, loggerInfoMock, contextHolder } = vi.hoisted(() => ({
    recorded: [] as Array<Record<string, unknown>>,
    createRemoteProxyMock: vi.fn(() => ({ run: vi.fn() })),
    loggerErrorMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    contextHolder: { current: undefined as unknown },
}));

vi.mock('@trigger.dev/sdk', () => ({
    task: (params: Record<string, unknown>) => {
        recorded.push(params);
        return params;
    },
    logger: { info: loggerInfoMock, warn: vi.fn(), error: loggerErrorMock, debug: vi.fn(), log: vi.fn() },
}));

vi.mock('../trigger/worker/remote-proxy', () => ({ createRemoteProxy: createRemoteProxyMock }));

vi.mock('../trigger/worker/utils/worker-context.utils', () => ({
    withWorkerContext: async (_name: string, fn: (ctx: unknown) => Promise<unknown>) => fn(contextHolder.current),
}));

import {
    APP_BLUEPRINT_APPLY_RUNNER_REMOTE_NAME,
    APP_BLUEPRINT_APPLY_RUNNER_SEAM,
    APP_BLUEPRINT_APPLY_TASK_ID,
    AppBlueprintApplyWorkerModule,
    appBlueprintApplyTask,
    runAppBlueprintApplyTask,
} from '../tasks/trigger/app-blueprint-apply.task';

const WORK_ID = '00000000-0000-4000-8000-0000000000c1';
const PAYLOAD = { workId: WORK_ID, mode: 'upgrade' as const, blueprintId: 'umami', version: '0.2.0' };

describe('app-blueprint-apply (APW-03 T28)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('registers plan §6.1’s id and budget, equal to the API-side job id', async () => {
        const registered = recorded.find((entry) => entry.id === APP_BLUEPRINT_APPLY_TASK_ID) as Record<string, any>;
        expect(registered).toBeDefined();
        expect((appBlueprintApplyTask as unknown as { id: string }).id).toBe('app-blueprint-apply');
        expect(registered.maxDuration).toBe(300);
        expect(registered.retry).toEqual({ maxAttempts: 1 });
        const agent = await import('@ever-works/agent/app-works');
        expect(APP_BLUEPRINT_APPLY_TASK_ID).toBe(agent.APP_BLUEPRINT_APPLY_JOB_ID);
        expect(registered.maxDuration).toBe(agent.APP_BLUEPRINT_APPLY_MAX_DURATION_S);
    });

    it('proxies AppBlueprintApplyRunner — the name the API’s remoteMap publishes', () => {
        const providers =
            (Reflect.getMetadata('providers', AppBlueprintApplyWorkerModule) as Array<{
                provide?: unknown;
                useFactory?: (client: unknown) => unknown;
            }>) ?? [];
        const seam = providers.find((provider) => provider.provide === APP_BLUEPRINT_APPLY_RUNNER_SEAM);
        expect(seam).toBeDefined();
        const client = { callRemote: vi.fn() };
        seam!.useFactory!(client);
        expect(createRemoteProxyMock).toHaveBeenCalledWith(client, 'AppBlueprintApplyRunner');
        expect(APP_BLUEPRINT_APPLY_RUNNER_REMOTE_NAME).toBe('AppBlueprintApplyRunner');
    });

    it('runs the runner and reports its result', async () => {
        const run = vi.fn(async () => ({ status: 'proposed', pullRequest: { number: 41 } }));
        await expect(runAppBlueprintApplyTask(PAYLOAD, { run })).resolves.toMatchObject({
            status: 'ran',
            jobId: 'app-blueprint-apply',
            workId: WORK_ID,
            mode: 'upgrade',
            result: { status: 'proposed' },
        });
        expect(run).toHaveBeenCalledWith(PAYLOAD);
    });

    it('names every refusal: no seam, no work id, a rejecting RPC', async () => {
        await expect(runAppBlueprintApplyTask(PAYLOAD, null)).resolves.toMatchObject({
            status: 'skipped',
            reason: 'runnerUnavailable',
        });
        await expect(runAppBlueprintApplyTask({} as never, { run: vi.fn() })).resolves.toMatchObject({
            status: 'skipped',
            reason: 'invalidPayload',
        });
        const run = vi.fn(async () => {
            throw new Error('Unknown remote target: AppBlueprintApplyRunner');
        });
        await expect(runAppBlueprintApplyTask(PAYLOAD, { run })).resolves.toMatchObject({
            status: 'failed',
            reason: 'runFailed',
            error: 'Unknown remote target: AppBlueprintApplyRunner',
        });
    });

    it('resolves the seam from the worker context in the task body', async () => {
        const run = vi.fn(async () => ({ status: 'unchanged' }));
        contextHolder.current = { get: vi.fn((token: unknown) => (token === APP_BLUEPRINT_APPLY_RUNNER_SEAM ? { run } : undefined)) };
        const registered = recorded.find((entry) => entry.id === APP_BLUEPRINT_APPLY_TASK_ID) as {
            run: (payload: unknown) => Promise<unknown>;
        };
        await expect(registered.run(PAYLOAD)).resolves.toMatchObject({ status: 'ran', result: { status: 'unchanged' } });
        contextHolder.current = {
            get: vi.fn(() => {
                throw new Error('no provider');
            }),
        };
        await expect(registered.run(PAYLOAD)).resolves.toMatchObject({ status: 'skipped', reason: 'runnerUnavailable' });
        expect(loggerErrorMock).toHaveBeenCalled();
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { Work, User } = vi.hoisted(() => {
    class Work {
        id?: string;
        slug?: string;
        user?: any;
    }
    class User {
        id?: string;
        email?: string;
    }
    return { Work, User };
});

vi.mock('@ever-works/agent/entities', () => ({ Work, User }));

import { createTaskContext } from '../trigger/worker/utils/task-context.utils';
import { TriggerInternalApiClient } from '../trigger/worker/services/trigger-internal-api.client';
import { TriggerPluginHydratorService } from '../trigger/worker/services/trigger-plugin-hydrator.service';

class FakeOrchestrator {
    name = 'fake-orchestrator';
}

// H-22: createTaskContext now requires UUID-shaped workId / userId in the
// payload. Use deterministic UUIDs in the spec so we test BOTH the happy
// path AND can add an "invalid UUID rejected" case below.
const TEST_WORK_ID = '11111111-2222-4333-8444-555555555555';
const TEST_USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TEST_WORK_ID_2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const TEST_USER_ID_2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

describe('createTaskContext', () => {
    let hydrator: { initialize: ReturnType<typeof vi.fn> };
    let apiClient: { fetchWorkContext: ReturnType<typeof vi.fn> };
    let orchestratorInstance: FakeOrchestrator;
    let appContext: { get: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        hydrator = { initialize: vi.fn().mockResolvedValue(undefined) };
        apiClient = { fetchWorkContext: vi.fn() };
        orchestratorInstance = new FakeOrchestrator();
        appContext = {
            get: vi.fn((token: any) => {
                if (token === TriggerPluginHydratorService) return hydrator;
                if (token === TriggerInternalApiClient) return apiClient;
                if (token === FakeOrchestrator) return orchestratorInstance;
                throw new Error(`Unexpected DI token: ${String(token)}`);
            }),
        };
    });

    it('initializes the plugin hydrator BEFORE fetching work context', async () => {
        const calls: string[] = [];
        hydrator.initialize.mockImplementation(async () => {
            calls.push('hydrate');
        });
        apiClient.fetchWorkContext.mockImplementation(async () => {
            calls.push('fetch');
            return { user: { id: 'u1' }, work: { id: 'w1' } };
        });

        await createTaskContext(
            appContext as any,
            { workId: TEST_WORK_ID, userId: TEST_USER_ID },
            FakeOrchestrator,
        );

        expect(calls).toEqual(['hydrate', 'fetch']);
    });

    it('forwards the workId + userId positionally to fetchWorkContext', async () => {
        apiClient.fetchWorkContext.mockResolvedValue({
            user: { id: 'u1' },
            work: { id: 'w1' },
        });

        await createTaskContext(
            appContext as any,
            { workId: TEST_WORK_ID_2, userId: TEST_USER_ID_2 },
            FakeOrchestrator,
        );

        expect(apiClient.fetchWorkContext).toHaveBeenCalledWith(TEST_WORK_ID_2, TEST_USER_ID_2);
    });

    it('hydrates plain objects into Work/User class instances via class-transformer', async () => {
        apiClient.fetchWorkContext.mockResolvedValue({
            user: { id: 'u1', email: 'a@b.c' },
            work: { id: 'w1', slug: 'my-work' },
        });

        const ctx = await createTaskContext(
            appContext as any,
            { workId: TEST_WORK_ID, userId: TEST_USER_ID },
            FakeOrchestrator,
        );

        expect(ctx.user).toBeInstanceOf(User);
        expect(ctx.user.id).toBe('u1');
        expect(ctx.user.email).toBe('a@b.c');
        expect(ctx.work).toBeInstanceOf(Work);
        expect(ctx.work.id).toBe('w1');
        expect(ctx.work.slug).toBe('my-work');
    });

    it('attaches the hydrated user back onto work.user', async () => {
        apiClient.fetchWorkContext.mockResolvedValue({
            user: { id: 'u1' },
            work: { id: 'w1' },
        });

        const ctx = await createTaskContext(
            appContext as any,
            { workId: TEST_WORK_ID, userId: TEST_USER_ID },
            FakeOrchestrator,
        );

        expect(ctx.work.user).toBe(ctx.user);
        expect(ctx.work.user.id).toBe('u1');
    });

    it('resolves the orchestrator using the supplied class token AFTER fetching context', async () => {
        const order: string[] = [];
        apiClient.fetchWorkContext.mockImplementation(async () => {
            order.push('fetch');
            return { user: { id: 'u' }, work: { id: 'w' } };
        });
        appContext.get.mockImplementation((token: any) => {
            if (token === TriggerPluginHydratorService) {
                order.push('get-hydrator');
                return hydrator;
            }
            if (token === TriggerInternalApiClient) {
                order.push('get-api-client');
                return apiClient;
            }
            if (token === FakeOrchestrator) {
                order.push('get-orchestrator');
                return orchestratorInstance;
            }
            throw new Error('Unexpected DI token');
        });

        const ctx = await createTaskContext(
            appContext as any,
            { workId: TEST_WORK_ID, userId: TEST_USER_ID },
            FakeOrchestrator,
        );

        expect(ctx.orchestrator).toBe(orchestratorInstance);
        // hydrator + api-client come before the fetch; orchestrator after.
        expect(order).toEqual(['get-hydrator', 'get-api-client', 'fetch', 'get-orchestrator']);
    });

    it('forwards the gitToken from the API response (when present)', async () => {
        apiClient.fetchWorkContext.mockResolvedValue({
            user: { id: 'u' },
            work: { id: 'w' },
            gitToken: 'ghp_xyz',
        });

        const ctx = await createTaskContext(
            appContext as any,
            { workId: TEST_WORK_ID, userId: TEST_USER_ID },
            FakeOrchestrator,
        );

        expect(ctx.gitToken).toBe('ghp_xyz');
    });

    it('leaves gitToken undefined when the API omits it', async () => {
        apiClient.fetchWorkContext.mockResolvedValue({
            user: { id: 'u' },
            work: { id: 'w' },
        });

        const ctx = await createTaskContext(
            appContext as any,
            { workId: TEST_WORK_ID, userId: TEST_USER_ID },
            FakeOrchestrator,
        );

        expect(ctx.gitToken).toBeUndefined();
    });

    it('propagates errors from the hydrator and skips the fetch entirely', async () => {
        hydrator.initialize.mockRejectedValueOnce(new Error('plugin-load-failed'));

        await expect(
            createTaskContext(
                appContext as any,
                { workId: TEST_WORK_ID, userId: TEST_USER_ID },
                FakeOrchestrator,
            ),
        ).rejects.toThrow('plugin-load-failed');

        expect(apiClient.fetchWorkContext).not.toHaveBeenCalled();
    });

    it('propagates errors from fetchWorkContext (no orchestrator resolution attempted)', async () => {
        apiClient.fetchWorkContext.mockRejectedValueOnce(new Error('api-down'));

        await expect(
            createTaskContext(
                appContext as any,
                { workId: TEST_WORK_ID, userId: TEST_USER_ID },
                FakeOrchestrator,
            ),
        ).rejects.toThrow('api-down');

        // appContext.get was called for hydrator + api-client + … but NOT for the orchestrator
        const tokens = appContext.get.mock.calls.map((c) => c[0]);
        expect(tokens).toContain(TriggerPluginHydratorService);
        expect(tokens).toContain(TriggerInternalApiClient);
        expect(tokens).not.toContain(FakeOrchestrator);
    });

    // H-22: payload-boundary UUID validation.
    it('rejects non-UUID workId before hitting the hydrator (H-22)', async () => {
        await expect(
            createTaskContext(
                appContext as any,
                { workId: 'not-a-uuid', userId: TEST_USER_ID },
                FakeOrchestrator,
            ),
        ).rejects.toThrow(/Invalid payload.workId/);
        expect(hydrator.initialize).not.toHaveBeenCalled();
        expect(apiClient.fetchWorkContext).not.toHaveBeenCalled();
    });

    it('rejects non-UUID userId before hitting the hydrator (H-22)', async () => {
        await expect(
            createTaskContext(
                appContext as any,
                { workId: TEST_WORK_ID, userId: 'not-a-uuid' },
                FakeOrchestrator,
            ),
        ).rejects.toThrow(/Invalid payload.userId/);
        expect(hydrator.initialize).not.toHaveBeenCalled();
        expect(apiClient.fetchWorkContext).not.toHaveBeenCalled();
    });
});

import { TaskWorkspaceService } from '../task-workspace.service';
import type { Task } from '../../entities/task.entity';

/**
 * APW-08 T54 — `TaskWorkspaceService.postSystemMessage` takes a keyed post (`{ key, params }`) IN
 * ADDITION TO the plain `body` string every existing caller passes. A keyed post stores the key
 * and params and writes the pre-rendered English into `body`; a string writes exactly the row it
 * always did (no key, no params).
 */
describe('TaskWorkspaceService.postSystemMessage (APW-08 T54)', () => {
    const task = { id: 'task-1', userId: 'user-1' } as unknown as Task;
    const input = { task, userId: 'user-1', agentId: 'agent-1' };

    function harness() {
        const post = jest.fn(async (_userId: string, _message: Record<string, unknown>) => undefined);
        const service = new TaskWorkspaceService(
            {} as never, // works
            {} as never, // tasks
            {} as never, // runs
            undefined as never, // workspaceFacade
            undefined as never, // gitFacade
            undefined as never, // transitions
            { post } as never, // taskChat
        );
        const postSystemMessage = (
            service as unknown as {
                postSystemMessage: (i: typeof input, m: unknown) => Promise<void>;
            }
        ).postSystemMessage.bind(service);
        return { post, postSystemMessage };
    }

    it('an existing string caller is unchanged: the agent, the body, no key', async () => {
        const { post, postSystemMessage } = harness();
        await postSystemMessage(input, 'Merged PR #7 into `main`.');
        expect(post).toHaveBeenCalledWith('user-1', {
            taskId: 'task-1',
            authorType: 'agent',
            authorId: 'agent-1',
            body: 'Merged PR #7 into `main`.',
        });
    });

    it('a keyed post stores the key and params, with the English rendered into body', async () => {
        const { post, postSystemMessage } = harness();
        await postSystemMessage(input, { key: 'deliveryPosts.prOpened', params: { number: 7 } });
        expect(post).toHaveBeenCalledWith('user-1', {
            taskId: 'task-1',
            authorType: 'agent',
            authorId: 'agent-1',
            body: 'Opened pull request #7.',
            messageKey: 'deliveryPosts.prOpened',
            messageParams: { number: 7 },
        });
    });

    it("a keyed post keeps the caller's own body when one is given", async () => {
        const { post, postSystemMessage } = harness();
        await postSystemMessage(input, { key: 'deliveryPosts.checksPassed', body: 'All 4 checks passed.' });
        expect(post.mock.calls[0][1]).toMatchObject({
            body: 'All 4 checks passed.',
            messageKey: 'deliveryPosts.checksPassed',
            messageParams: null,
        });
    });

    it('a failing chat write is swallowed (the finalize path must not throw)', async () => {
        const { post, postSystemMessage } = harness();
        post.mockRejectedValueOnce(new Error('db down'));
        await expect(postSystemMessage(input, 'anything')).resolves.toBeUndefined();
    });
});

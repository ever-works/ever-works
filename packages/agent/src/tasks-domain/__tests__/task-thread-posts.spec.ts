import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { TaskChatService } from '../task-chat.service';
import {
    TASK_THREAD_POST_ENGLISH,
    renderTaskThreadPost,
    taskThreadPost,
    taskThreadPostKey,
    type TaskThreadPostLeaf,
} from '../task-thread-posts';

/**
 * APW-08 T54 / T26 (FR-43, ACC-08-24 keyed half) — keyed Task-thread posts.
 *
 *  - the English `body` fallback is rendered from the key and its params;
 *  - the agent's English and the web's `dashboard.tasksPage.deliveryPosts` copy are the SAME
 *    strings (the reader sees the key rendered, an older reader sees `body`: they must agree);
 *  - `TaskChatService.post` stores a `system` post with no author, a key and its params, and
 *    every existing caller (no key) writes the row it always did.
 */

const EN = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../../apps/web/messages/en.json'), 'utf8'),
) as { dashboard: { tasksPage: { deliveryPosts: Record<string, string> } } };

describe('task-thread-posts — the copy', () => {
    it('renders the English body from the key and its params', () => {
        expect(renderTaskThreadPost(taskThreadPost('merged', { branch: 'production' }))).toBe(
            'Merged into production.',
        );
        expect(
            renderTaskThreadPost(taskThreadPost('buildFailed', { number: 4, reason: 'compile' })),
        ).toBe('Build #4 failed: compile.');
        expect(
            renderTaskThreadPost(taskThreadPost('deployFailed', { outcome: 'rollback_failed' })),
        ).toBe('Deployment failed: rollback failed.');
        expect(renderTaskThreadPost(taskThreadPost('followUpOpened', { taskSlug: 'T-2' }))).toBe(
            'Opened follow-up T-2.',
        );
    });

    it('drops null params, and an unknown key renders as itself instead of throwing', () => {
        expect(taskThreadPost('live', { url: null })).toEqual({ key: 'deliveryPosts.live' });
        expect(renderTaskThreadPost({ key: 'deliveryPosts.nope' })).toBe('deliveryPosts.nope');
    });

    it.each([['toString'], ['constructor'], ['hasOwnProperty'], ['__proto__']])(
        'an inherited name (%s) is an unknown key, not a template (CodeRabbit on #3033)',
        (leaf) => {
            const key = `deliveryPosts.${leaf}`;
            expect(renderTaskThreadPost({ key })).toBe(key);
        },
    );

    it('every key fits the 64-character column and is camelCase with no literal dot in the leaf', () => {
        for (const leaf of Object.keys(TASK_THREAD_POST_ENGLISH) as TaskThreadPostLeaf[]) {
            const key = taskThreadPostKey(leaf);
            expect(key.length).toBeLessThanOrEqual(64);
            expect(leaf).toMatch(/^[a-z][A-Za-z0-9]*$/);
        }
    });

    it('the web copy of record (en.json deliveryPosts) carries exactly these strings', () => {
        const web = EN.dashboard.tasksPage.deliveryPosts;
        for (const [leaf, english] of Object.entries(TASK_THREAD_POST_ENGLISH)) {
            expect([leaf, web[leaf]]).toEqual([leaf, english]);
        }
    });
});

describe('TaskChatService.post — keyed posts (T54)', () => {
    let tasks: { findByIdAndUser: jest.Mock };
    let messages: { create: jest.Mock };
    let activity: { log: jest.Mock };
    let svc: TaskChatService;

    beforeEach(() => {
        tasks = { findByIdAndUser: jest.fn().mockResolvedValue({ id: 't1', userId: 'u1' }) };
        messages = {
            create: jest.fn((data: Record<string, unknown>) =>
                Promise.resolve({ id: 'm1', ...data }),
            ),
        };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        svc = new TaskChatService(
            tasks as never,
            messages as never,
            { add: jest.fn() } as never,
            activity as never,
        );
    });

    it('stores a system post with no author id, its key and its params', async () => {
        await svc.post('u1', {
            taskId: 't1',
            authorType: 'system',
            authorId: null,
            body: 'Live at https://bookings.example.app.',
            messageKey: 'deliveryPosts.live',
            messageParams: { url: 'https://bookings.example.app' },
        });
        expect(messages.create.mock.calls[0][0]).toMatchObject({
            taskId: 't1',
            authorType: 'system',
            authorId: null,
            body: 'Live at https://bookings.example.app.',
            messageKey: 'deliveryPosts.live',
            messageParams: { url: 'https://bookings.example.app' },
        });
    });

    it('an existing caller (no key) writes the row it always did: no key, no params', async () => {
        await svc.post('u1', { taskId: 't1', authorType: 'user', authorId: 'u1', body: 'hello' });
        expect(messages.create.mock.calls[0][0]).toMatchObject({
            authorType: 'user',
            authorId: 'u1',
            body: 'hello',
            messageKey: null,
            messageParams: null,
        });
    });

    it('refuses a person, agent or integration message with no author', async () => {
        await expect(
            svc.post('u1', { taskId: 't1', authorType: 'agent', authorId: null, body: 'hi' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(messages.create).not.toHaveBeenCalled();
    });

    it('drops a malformed or over-long key (the English body still posts) and params without a key', async () => {
        await svc.post('u1', {
            taskId: 't1',
            authorType: 'system',
            authorId: null,
            body: 'Deploying.',
            messageKey: 'not a key',
            messageParams: { x: 1 },
        });
        await svc.post('u1', {
            taskId: 't1',
            authorType: 'system',
            authorId: null,
            body: 'Deploying.',
            messageKey: `deliveryPosts.${'a'.repeat(60)}`,
        });
        for (const call of messages.create.mock.calls) {
            expect(call[0]).toMatchObject({
                body: 'Deploying.',
                messageKey: null,
                messageParams: null,
            });
        }
    });
});

/**
 * Lead review of #3033 — a `system` post lives in the Task thread ONLY: it writes the thread row,
 * but fires no `task.comment.created` domain / integration event and writes no "commented"
 * Activity row (the delivery chain's own `app_change` rows record each state). A user or agent
 * post still does both, exactly as before.
 */
describe('TaskChatService.post — a system post is thread-only (T54)', () => {
    let messages: { create: jest.Mock };
    let activity: { log: jest.Mock };
    let publisher: { transaction: jest.Mock; child: jest.Mock };
    let svc: TaskChatService;
    const MANAGER = { tx: true };

    beforeEach(() => {
        messages = {
            create: jest.fn((data: Record<string, unknown>) =>
                Promise.resolve({
                    id: 'm1',
                    createdAt: new Date(0),
                    updatedAt: new Date(0),
                    ...data,
                }),
            ),
        };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        publisher = {
            transaction: jest.fn(async (work: (manager: unknown) => Promise<unknown>) =>
                work(MANAGER),
            ),
            child: jest.fn().mockResolvedValue(undefined),
        };
        svc = new TaskChatService(
            { findByIdAndUser: jest.fn().mockResolvedValue({ id: 't1', userId: 'u1' }) } as never,
            messages as never,
            { add: jest.fn() } as never,
            activity as never,
            undefined, // runs
            undefined, // chatDispatcher
            undefined, // steering
            undefined, // dispatchGate
            publisher as never, // domainEvents
        );
    });

    const commented = () =>
        activity.log.mock.calls.filter(
            ([entry]) => (entry as { actionType?: string }).actionType === 'task_commented',
        );

    it('a system post writes the thread row, and no comment event and no commented Activity row', async () => {
        const row = await svc.post('u1', {
            taskId: 't1',
            authorType: 'system',
            authorId: null,
            body: 'Deploying.',
            messageKey: 'deliveryPosts.deploying',
        });
        expect(row).toMatchObject({ authorType: 'system', authorId: null, body: 'Deploying.' });
        expect(messages.create).toHaveBeenCalledTimes(1);
        // Written outside the event transaction: no manager, no event.
        expect(messages.create.mock.calls[0][1]).toBeUndefined();
        expect(publisher.transaction).not.toHaveBeenCalled();
        expect(publisher.child).not.toHaveBeenCalled();
        expect(activity.log).not.toHaveBeenCalled();
    });

    it.each([
        ['user', 'u1'],
        ['agent', 'agent-1'],
    ])(
        'a %s post still fires task.comment.created and writes the commented Activity row',
        async (authorType, authorId) => {
            await svc.post('u1', {
                taskId: 't1',
                authorType: authorType as 'user' | 'agent',
                authorId,
                body: 'Looks good.',
            });
            expect(publisher.transaction).toHaveBeenCalledTimes(1);
            expect(messages.create.mock.calls[0][1]).toBe(MANAGER);
            expect(publisher.child).toHaveBeenCalledTimes(1);
            const [, aggregate, taskId, event, payload] = publisher.child.mock.calls[0];
            expect([aggregate, taskId, event]).toEqual(['task', 't1', 'task.comment.created']);
            expect(payload).toMatchObject({ authorType, authorId, body: 'Looks good.' });
            expect(commented()).toHaveLength(1);
            expect(commented()[0][0]).toMatchObject({
                details: expect.objectContaining({ messageId: 'm1' }),
            });
        },
    );
});

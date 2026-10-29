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
        expect(renderTaskThreadPost(taskThreadPost('buildFailed', { number: 4, reason: 'compile' }))).toBe(
            'Build #4 failed: compile.',
        );
        expect(renderTaskThreadPost(taskThreadPost('deployFailed', { outcome: 'rollback_failed' }))).toBe(
            'Deployment failed: rollback failed.',
        );
        expect(renderTaskThreadPost(taskThreadPost('followUpOpened', { taskSlug: 'T-2' }))).toBe(
            'Opened follow-up T-2.',
        );
    });

    it('drops null params, and an unknown key renders as itself instead of throwing', () => {
        expect(taskThreadPost('live', { url: null })).toEqual({ key: 'deliveryPosts.live' });
        expect(renderTaskThreadPost({ key: 'deliveryPosts.nope' })).toBe('deliveryPosts.nope');
    });

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
        messages = { create: jest.fn((data: Record<string, unknown>) => Promise.resolve({ id: 'm1', ...data })) };
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
            expect(call[0]).toMatchObject({ body: 'Deploying.', messageKey: null, messageParams: null });
        }
    });
});

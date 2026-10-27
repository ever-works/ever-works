import { BadRequestException } from '@nestjs/common';
import {
    GITHUB_FOR_ME_LABEL,
    GITHUB_FOR_ME_TRIGGER_NAME,
    InboundTriggersService,
} from '../inbound-triggers.service';
import { WebhookSubscriptionSecretService } from '../../services/webhook-subscription-secret.service';
import type { InboundTrigger } from '../../entities/inbound-trigger.entity';
import type { IngestedEvent } from '../../entities/ingested-event.entity';

/**
 * FL-15 P3 — **GitHub: things for me** (spec FR-18, FR-19, U11, U12,
 * ACC-FL15-11/12): the preset creates one event Trigger with the audience,
 * parked in the Backlog; it is refused without a linked GitHub account; an
 * event fires only when it is about the owner's login; the Task carries the
 * `github` label; a second event about the same pull request posts on its
 * Task instead of making another.
 */

const SCOPE = { userId: 'user-1', organizationId: null };

function makeRepo() {
    const rows = new Map<string, InboundTrigger>();
    let seq = 0;
    return {
        create: jest.fn((partial: Partial<InboundTrigger>) => ({ ...partial })),
        save: jest.fn(async (row: Partial<InboundTrigger>) => {
            const saved = {
                createdAt: new Date(),
                updatedAt: new Date(),
                ...row,
                id: row.id ?? `trigger-${++seq}`,
            } as InboundTrigger;
            rows.set(saved.id, saved);
            return saved;
        }),
        find: jest.fn(async () => [...rows.values()]),
        findOne: jest.fn(
            async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        ),
        update: jest.fn(async () => undefined),
    };
}

/** A claim ledger whose `complete` writes the Task back, as the real one does. */
function makeFires() {
    const rows = new Map<
        string,
        { id: string; taskId: string | null; status: string; firedAt: Date }
    >();
    const byId = new Map<string, string>();
    let seq = 0;
    return {
        claim: jest.fn(async (triggerId: string, dedupeKey: string) => {
            const key = `${triggerId}|${dedupeKey}`;
            const existing = rows.get(key);
            if (existing) return { fire: { ...existing }, won: false };
            const fire = {
                id: `fire-${++seq}`,
                taskId: null,
                status: 'running',
                firedAt: new Date(),
            };
            rows.set(key, fire);
            byId.set(fire.id, key);
            return { fire: { ...fire }, won: true };
        }),
        complete: jest.fn(
            async (id: string, status: string, patch: { taskId?: string | null } = {}) => {
                const key = byId.get(id);
                const row = key ? rows.get(key) : undefined;
                if (row) {
                    row.status = status;
                    row.taskId = patch.taskId ?? null;
                }
            },
        ),
        listRecent: jest.fn(async () => []),
    };
}

function makeService(options: { linked?: boolean } = {}) {
    const repo = makeRepo();
    const fires = makeFires();
    let seq = 0;
    const tasks = {
        create: jest.fn(async (_userId: string, input: { title: string }) => ({
            id: `task-${++seq}`,
            slug: `T-${seq}`,
            title: input.title,
        })),
        addAssignee: jest.fn(async () => ({ id: 'a' })),
        runTask: jest.fn(async () => ({})),
    };
    const agents = { findByIdAndUser: jest.fn(async (id: string) => ({ id })) };
    const githubLinks = {
        findByUserId: jest.fn(async () =>
            options.linked === false
                ? null
                : { userId: 'user-1', githubUserId: '1', githubLogin: 'Nina' },
        ),
    };
    const taskChat = { post: jest.fn(async () => ({ id: 'message-1' })) };
    const secrets = new WebhookSubscriptionSecretService();
    jest.spyOn(
        (secrets as unknown as { logger: { warn: (msg: string) => void } }).logger,
        'warn',
    ).mockImplementation(() => undefined);
    const service = new InboundTriggersService(
        repo as never,
        secrets,
        tasks as never,
        agents as never,
        fires as never,
        undefined as never,
        githubLinks as never,
        taskChat as never,
    );
    return { service, repo, tasks, taskChat };
}

const reviewRequest = (id: string, reviewer = 'nina'): IngestedEvent =>
    ({
        id,
        userId: 'user-1',
        organizationId: null,
        workId: null,
        source: 'github',
        sourceEventId: `src-${id}`,
        kind: 'github.pr',
        occurredAt: new Date(),
        actorName: 'lead',
        subjectType: 'pull_request',
        subjectExternalId: 'acme/api#912',
        title: 'Fix the cookie',
        sourceUrl: 'https://github.com/acme/api/pull/912',
        payload: {
            action: 'review_requested',
            requestedReviewer: reviewer,
            repoFullName: 'acme/api',
            prNumber: 912,
        },
        processedAt: null,
        dedupeKey: `dedupe-${id}`,
        createdAt: new Date(),
    }) as unknown as IngestedEvent;

describe('InboundTriggersService — GitHub: things for me (FL-15 P3)', () => {
    const ORIGINAL_KEY = process.env.PLATFORM_ENCRYPTION_KEY;
    beforeEach(() => {
        delete process.env.PLATFORM_ENCRYPTION_KEY;
    });
    afterAll(() => {
        if (ORIGINAL_KEY === undefined) delete process.env.PLATFORM_ENCRYPTION_KEY;
        else process.env.PLATFORM_ENCRYPTION_KEY = ORIGINAL_KEY;
    });

    it('creates one event Trigger about me, parked in the Backlog', async () => {
        const { service } = makeService();
        const { trigger } = await service.createGithubForMe(SCOPE, {});
        expect(trigger.name).toBe(GITHUB_FOR_ME_TRIGGER_NAME);
        expect(trigger.sourceType).toBe('event');
        expect(trigger.autoStart).toBe('manual');
        expect(trigger.eventMatcher).toEqual({
            source: 'github',
            kind: 'github.*',
            audience: { me: ['review-requested', 'assigned', 'authored'] },
        });
    });

    it('refuses without a linked GitHub account (U11)', async () => {
        const { service } = makeService({ linked: false });
        await expect(service.createGithubForMe(SCOPE, {})).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('fires only for the owner’s login, labels the Task, and coalesces a repeat onto it (U12)', async () => {
        const { service, tasks, taskChat } = makeService();
        await service.createGithubForMe(SCOPE, {});
        const other = await service.fireForEvent(reviewRequest('event-0', 'someone-else'));
        expect(other.fired).toBe(0);

        const first = await service.fireForEvent(reviewRequest('event-1'));
        expect(first.fired).toBe(1);
        expect(tasks.create).toHaveBeenCalledTimes(1);
        expect((tasks.create.mock.calls[0] as unknown[])[1]).toEqual(
            expect.objectContaining({ labels: [GITHUB_FOR_ME_LABEL] }),
        );

        const second = await service.fireForEvent(reviewRequest('event-2'));
        expect(second.fired).toBe(0);
        expect(second.deduped).toBe(1);
        expect(tasks.create).toHaveBeenCalledTimes(1);
        expect(taskChat.post).toHaveBeenCalledWith(
            'user-1',
            expect.objectContaining({
                taskId: 'task-1',
                body: expect.stringContaining('acme/api#912'),
            }),
        );
    });
});

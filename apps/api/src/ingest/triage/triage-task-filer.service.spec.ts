import { BadRequestException } from '@nestjs/common';

jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    ExternalIssueLinkService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskRepository: class {},
    TaskGitLinkService: class {},
    TaskReviewRejectionService: class {},
    TaskPriority: { P0: 'p0', P1: 'p1', P2: 'p2', P3: 'p3', P4: 'p4' },
}));
jest.mock('@ever-works/agent/utils', () => ({
    // A tiny stand-in for the real scanner: the filer's contract is that
    // the rendered body goes THROUGH the redactor before it is persisted.
    redactSecrets: (body: string) => {
        const cleaned = body.split('ghp_' + 'A'.repeat(36)).join('[redacted secret]');
        return { cleaned, redactions: cleaned === body ? 0 : 1 };
    },
}));
jest.mock('@ever-works/agent/pr-review', () => ({ PrReviewService: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));
jest.mock('@ever-works/agent/database', () => ({
    GitHubAppInstallationRepository: class {},
    GitHubAppUserLinkRepository: class {},
    WorkRepository: class {},
}));
jest.mock('../../integrations/github-app/github-app-sync.service', () => ({
    GitHubAppSyncService: class {},
}));

import type { IngestedEvent } from '@ever-works/agent/ingest';
import { GITHUB_ISSUE_EVENT_KIND } from '../github/github-issue-intake.service';
import { INCIDENT_EVENT_KIND } from '../incidents/incident-source.types';
import { JIRA_ISSUE_EVENT_KIND } from '../jira/jira-issue-bridge.service';
import { TRIAGE_EVENT_KINDS, TRIAGE_LABEL } from './triage-task-body';
import { TriageTaskFilerService } from './triage-task-filer.service';

const WORK = { id: 'work-1', userId: 'user-1', tenantId: 'tenant-1', organizationId: 'org-1' };
const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' };

const storedEvent = (overrides: Partial<IngestedEvent> = {}): IngestedEvent =>
    ({
        id: 'row-1',
        userId: 'user-1',
        organizationId: null,
        workId: 'work-1',
        source: 'github',
        sourceEventId: 'issue:octo/site#42@opened:2026-09-01T09:00:00.000Z',
        kind: 'github.issue',
        occurredAt: new Date('2026-09-01T09:00:00.000Z'),
        actorName: 'octocat',
        subjectType: 'issue',
        subjectExternalId: 'octo/site#42',
        title: 'Login button does nothing on Safari',
        sourceUrl: 'https://github.com/octo/site/issues/42',
        payload: {
            action: 'opened',
            repoFullName: 'octo/site',
            issueNumber: 42,
            title: 'Login button does nothing on Safari',
            state: 'open',
            labels: ['bug'],
            assignees: [],
            author: 'reporter',
            url: 'https://github.com/octo/site/issues/42',
            body: 'Steps to reproduce.',
        },
        processedAt: null,
        dedupeKey: 'abc',
        createdAt: new Date('2026-09-01T09:00:05.000Z'),
        ...overrides,
    }) as IngestedEvent;

const sentryEvent = (overrides: Partial<IngestedEvent> = {}): IngestedEvent =>
    storedEvent({
        id: 'row-s1',
        source: 'sentry',
        kind: 'incident',
        sourceEventId: 'issue:4501:created:2026-09-01T12:00:00.000Z',
        occurredAt: new Date('2026-09-01T12:00:00.000Z'),
        subjectExternalId: '4501',
        title: 'TypeError: Cannot read properties of undefined',
        sourceUrl: 'https://sentry.io/organizations/ever-co/issues/4501/',
        payload: {
            provider: 'sentry',
            externalId: '4501',
            title: 'TypeError: Cannot read properties of undefined',
            url: 'https://sentry.io/organizations/ever-co/issues/4501/',
            culprit: 'tasks.service.ts in create',
            level: 'fatal',
            release: 'ever-works@1.42.0',
            environment: 'production',
            project: 'ever-works-api',
            status: 'unresolved',
            action: 'created',
            resource: 'issue',
            issueId: '4501',
            shortId: 'EVER-WORKS-1X',
        },
        ...overrides,
    });

function build() {
    const eventIngest = { registerKindProcessor: jest.fn() };
    const links = { find: jest.fn().mockResolvedValue(null), link: jest.fn() };
    const works = { findById: jest.fn().mockResolvedValue(WORK) };
    let nextTask = 1;
    const tasks = {
        create: jest.fn(
            async (
                _userId: string,
                input: { title: string } & Record<string, unknown>,
                _scope?: { tenantId: string | null; organizationId: string | null },
            ) => ({
                id: `task-${nextTask++}`,
                slug: `T-${nextTask}`,
                title: input.title,
                tenantId: 'tenant-1',
                organizationId: 'org-1',
            }),
        ),
        remove: jest.fn().mockResolvedValue({ deleted: true }),
    };
    const taskRows = { findByIdAndUser: jest.fn().mockResolvedValue(null) };
    const chat = { post: jest.fn().mockResolvedValue({ id: 'msg-1' }) };
    links.link.mockImplementation(async (input: { taskId: string }) => ({
        id: 'link-1',
        ...input,
    }));
    const filer = new TriageTaskFilerService(
        eventIngest as never,
        links as never,
        works as never,
        tasks as never,
        taskRows as never,
        chat as never,
    );
    return { filer, eventIngest, links, works, tasks, taskRows, chat };
}

describe('TriageTaskFilerService', () => {
    it('registers itself as a kind processor for exactly the three intake kinds', () => {
        const { filer, eventIngest } = build();
        filer.onModuleInit();
        expect(eventIngest.registerKindProcessor).toHaveBeenCalledTimes(1);
        const processor = eventIngest.registerKindProcessor.mock.calls[0][0];
        expect(processor.kinds).toBe(TRIAGE_EVENT_KINDS);
        // Pinned against the producers' own constants, so a renamed kind
        // cannot silently stop reaching the filer.
        expect(TRIAGE_EVENT_KINDS).toEqual(
            expect.arrayContaining([
                GITHUB_ISSUE_EVENT_KIND,
                JIRA_ISSUE_EVENT_KIND,
                INCIDENT_EVENT_KIND,
            ]),
        );
        expect(TRIAGE_EVENT_KINDS).toHaveLength(3);
    });

    describe('first sight → one Task + the persisted dedup key', () => {
        it('files exactly one Task in the bound Work under its tenant/organization scope and links it', async () => {
            const { filer, tasks, links, chat } = build();

            const result = await filer.process(storedEvent());

            expect(result).toEqual({ outcome: 'filed', taskId: 'task-1' });
            expect(tasks.create).toHaveBeenCalledTimes(1);
            const [userId, input, scope] = tasks.create.mock.calls[0];
            expect(userId).toBe('user-1');
            expect(scope).toEqual(SCOPE);
            expect(input).toMatchObject({
                title: '[octo/site#42] Login button does nothing on Safari',
                workId: 'work-1',
                labels: [TRIAGE_LABEL, 'source:github'],
                priority: 'p3',
                createdByType: 'user',
                createdById: 'user-1',
            });
            expect(input.description).toContain(
                '| Link | https://github.com/octo/site/issues/42 |',
            );
            expect(input.description).toContain('Steps to reproduce.');

            // The dedup key: (userId, source, externalIssueId) → the Task, stamped with this event.
            expect(links.link).toHaveBeenCalledTimes(1);
            expect(links.link).toHaveBeenCalledWith({
                userId: 'user-1',
                taskId: 'task-1',
                source: 'github',
                externalIssueId: 'octo/site#42',
                externalKey: 'octo/site#42',
                title: 'Login button does nothing on Safari',
                url: 'https://github.com/octo/site/issues/42',
                tenantId: 'tenant-1',
                organizationId: 'org-1',
                lastIngestedEventId: 'row-1',
                lastSeenAt: new Date('2026-09-01T09:00:00.000Z'),
            });
            expect(chat.post).not.toHaveBeenCalled();
        });

        it('renders a Sentry incident with culprit, level, release, environment and project — at P1 for fatal', async () => {
            const { filer, tasks } = build();

            await filer.process(sentryEvent());

            const [, input] = tasks.create.mock.calls[0];
            expect(input.title).toBe(
                '[EVER-WORKS-1X] TypeError: Cannot read properties of undefined',
            );
            expect(input.priority).toBe('p1');
            expect(input.labels).toEqual([TRIAGE_LABEL, 'source:sentry']);
            expect(input.description).toContain('| Culprit | tasks.service.ts in create |');
            expect(input.description).toContain('| Level | fatal |');
            expect(input.description).toContain('| Last-seen release | ever-works@1.42.0 |');
            expect(input.description).toContain('| Environment | production |');
            expect(input.description).toContain('| Project | ever-works-api |');
        });

        it('passes the rendered body through the secret redactor before persisting it', async () => {
            const { filer, tasks } = build();
            const leaky = storedEvent({
                payload: {
                    ...storedEvent().payload,
                    body: `token is ghp_${'A'.repeat(36)} please rotate`,
                },
            });

            await filer.process(leaky);

            const [, input] = tasks.create.mock.calls[0];
            expect(input.description).toContain('[redacted secret]');
            expect(input.description).not.toContain('ghp_');
        });
    });

    describe('later revisions → update, never a second Task', () => {
        const existingLink = {
            id: 'link-1',
            userId: 'user-1',
            taskId: 'task-9',
            source: 'github',
            externalIssueId: 'octo/site#42',
            title: 'Login button does nothing on Safari',
            url: 'https://github.com/octo/site/issues/42',
            lastIngestedEventId: 'row-0',
            tenantId: 'tenant-1',
            organizationId: 'org-1',
        };
        const existingTask = { id: 'task-9', tenantId: 'tenant-1', organizationId: 'org-1' };

        it('posts ONE comment on the existing Task and refreshes the link — create is never called', async () => {
            const { filer, tasks, links, taskRows, chat } = build();
            links.find.mockResolvedValue(existingLink);
            taskRows.findByIdAndUser.mockResolvedValue(existingTask);
            const relabel = storedEvent({
                id: 'row-2',
                sourceEventId: 'issue:octo/site#42@labeled:bug:2026-09-01T10:00:00.000Z',
                occurredAt: new Date('2026-09-01T10:00:00.000Z'),
                payload: {
                    ...storedEvent().payload,
                    action: 'labeled',
                    label: 'bug',
                    title: 'Login is broken on Safari',
                },
            });

            const result = await filer.process(relabel);

            expect(result).toEqual({ outcome: 'updated', taskId: 'task-9', commented: true });
            expect(tasks.create).not.toHaveBeenCalled();
            expect(chat.post).toHaveBeenCalledTimes(1);
            const [userId, post, , scope] = chat.post.mock.calls[0];
            expect(userId).toBe('user-1');
            expect(post).toMatchObject({
                taskId: 'task-9',
                authorType: 'user',
                authorId: 'user-1',
            });
            expect(post.body).toContain('**GitHub issue update** — labeled "bug"');
            expect(post.body).toContain(
                '- Title: "Login is broken on Safari" (was "Login button does nothing on Safari")',
            );
            expect(scope).toEqual(SCOPE);
            expect(links.link).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskId: 'task-9',
                    externalIssueId: 'octo/site#42',
                    title: 'Login is broken on Safari',
                    lastIngestedEventId: 'row-2',
                    lastSeenAt: new Date('2026-09-01T10:00:00.000Z'),
                }),
            );
        });

        it('a retry of the very same drained row is a no-op (no comment, no link write)', async () => {
            const { filer, tasks, links, taskRows, chat } = build();
            links.find.mockResolvedValue({ ...existingLink, lastIngestedEventId: 'row-1' });

            const result = await filer.process(storedEvent({ id: 'row-1' }));

            expect(result).toEqual({ outcome: 'noop', taskId: 'task-9' });
            expect(taskRows.findByIdAndUser).not.toHaveBeenCalled();
            expect(tasks.create).not.toHaveBeenCalled();
            expect(chat.post).not.toHaveBeenCalled();
            expect(links.link).not.toHaveBeenCalled();
        });

        it('a refused comment is best-effort — the link is still refreshed and nothing is duplicated', async () => {
            const { filer, tasks, links, taskRows, chat } = build();
            links.find.mockResolvedValue(existingLink);
            taskRows.findByIdAndUser.mockResolvedValue(existingTask);
            chat.post.mockRejectedValue(new BadRequestException('Chat body exceeds max'));

            const result = await filer.process(storedEvent({ id: 'row-3' }));

            expect(result).toEqual({ outcome: 'updated', taskId: 'task-9', commented: false });
            expect(tasks.create).not.toHaveBeenCalled();
            expect(links.link).toHaveBeenCalledWith(
                expect.objectContaining({ lastIngestedEventId: 'row-3' }),
            );
        });

        it('re-files when the linked Task was deleted, re-pointing the same dedup row', async () => {
            const { filer, tasks, links, taskRows } = build();
            links.find.mockResolvedValue(existingLink);
            taskRows.findByIdAndUser.mockResolvedValue(null);

            const result = await filer.process(storedEvent({ id: 'row-4' }));

            expect(result).toEqual({ outcome: 'filed', taskId: 'task-1' });
            expect(tasks.create).toHaveBeenCalledTimes(1);
            expect(links.link).toHaveBeenCalledWith(
                expect.objectContaining({ taskId: 'task-1', externalIssueId: 'octo/site#42' }),
            );
        });
    });

    describe('the bound Work decides where a Task lands — never the payload', () => {
        it('files nothing when the event routed to no Work', async () => {
            const { filer, tasks, links, works } = build();

            const result = await filer.process(storedEvent({ workId: null }));

            expect(result).toEqual({ outcome: 'skipped', reason: 'no-work' });
            expect(works.findById).not.toHaveBeenCalled();
            expect(tasks.create).not.toHaveBeenCalled();
            expect(links.link).not.toHaveBeenCalled();
        });

        it('refuses a Work that is not owned by the event’s user', async () => {
            const { filer, tasks, links, works } = build();
            works.findById.mockResolvedValue({ ...WORK, userId: 'someone-else' });

            const result = await filer.process(storedEvent());

            expect(result).toEqual({ outcome: 'skipped', reason: 'work-unavailable' });
            expect(tasks.create).not.toHaveBeenCalled();
            expect(links.link).not.toHaveBeenCalled();
        });

        it('refuses a Work that no longer exists', async () => {
            const { filer, tasks, works } = build();
            works.findById.mockResolvedValue(null);

            await expect(filer.process(storedEvent())).resolves.toEqual({
                outcome: 'skipped',
                reason: 'work-unavailable',
            });
            expect(tasks.create).not.toHaveBeenCalled();
        });

        it('skips an event without a stable external id', async () => {
            const { filer, links } = build();
            await expect(filer.process(storedEvent({ subjectExternalId: null }))).resolves.toEqual({
                outcome: 'skipped',
                reason: 'no-external-id',
            });
            expect(links.find).not.toHaveBeenCalled();
        });
    });

    describe('failure posture', () => {
        it('swallows a permanent refusal of the Task (validation / secret scan) instead of retrying forever', async () => {
            const { filer, tasks, links } = build();
            tasks.create.mockRejectedValue(new BadRequestException('secret detected'));

            await expect(filer.process(storedEvent())).resolves.toEqual({
                outcome: 'skipped',
                reason: 'rejected',
            });
            expect(links.link).not.toHaveBeenCalled();
        });

        it('rethrows an infrastructure failure so the drain retries the row', async () => {
            const { filer, tasks } = build();
            tasks.create.mockRejectedValue(new Error('db down'));

            await expect(filer.process(storedEvent())).rejects.toThrow('db down');
        });

        it('removes the just-created Task when the dedup row cannot be written, then rethrows', async () => {
            const { filer, tasks, links } = build();
            links.link.mockRejectedValue(new Error('link write failed'));

            await expect(filer.process(storedEvent())).rejects.toThrow('link write failed');
            expect(tasks.create).toHaveBeenCalledTimes(1);
            expect(tasks.remove).toHaveBeenCalledWith('user-1', 'task-1', SCOPE);
        });
    });
});

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
    TaskStatus: {
        BACKLOG: 'backlog',
        TODO: 'todo',
        IN_PROGRESS: 'in_progress',
        IN_REVIEW: 'in_review',
        BLOCKED: 'blocked',
        DONE: 'done',
        CANCELLED: 'cancelled',
    },
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
                // A FIRST link is insert-only: a concurrent drain that
                // already filed keeps the key, so this filer's Task can
                // never orphan theirs (or be orphaned by them).
                onlyIfAbsent: true,
            });
            expect(chat.post).not.toHaveBeenCalled();
        });

        /**
         * `findUnprocessed` takes no row lock and `markProcessed` is the
         * last step of the fan-out, so before the drain became
         * single-flight two overlapping ticks handed the same first-sight
         * row to two filings: both missed the dedup row, both created a
         * Task, and the second write re-pointed the single link at the
         * winner. The loser was ORPHANED — nothing referenced it, so it
         * never received an update comment and was never deduped away,
         * and the board showed two triage Tasks for one issue.
         *
         * The insert-only first link makes the loser DETECTABLE: the row
         * it gets back names somebody else's Task, so it cleans up after
         * itself even if two processes race.
         */
        it('removes its own Task when a concurrent filer already holds the dedup key', async () => {
            const { filer, tasks, links } = build();
            links.link.mockResolvedValue({
                id: 'link-1',
                taskId: 'task-from-the-other-drain',
            });

            const result = await filer.process(storedEvent());

            expect(result).toEqual({ outcome: 'noop', taskId: 'task-from-the-other-drain' });
            expect(tasks.remove).toHaveBeenCalledWith('user-1', 'task-1', SCOPE);
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

    /**
     * The one case where dedup yields. Both halves of the condition are
     * driven through the real `process()`: the vendor must say it came
     * back AND the Task must already be closed. A regression is the only
     * thing that may open new work; nothing else may, or an alerting
     * Sentry issue would page the board forever.
     */
    describe('a regression re-opens work — and nothing else does', () => {
        const link = (overrides: Record<string, unknown> = {}) => ({
            id: 'link-1',
            userId: 'user-1',
            taskId: 'task-9',
            source: 'github',
            externalIssueId: 'octo/site#42',
            externalKey: 'octo/site#42',
            title: 'Login button does nothing on Safari',
            url: 'https://github.com/octo/site/issues/42',
            lastIngestedEventId: 'row-0',
            tenantId: 'tenant-1',
            organizationId: 'org-1',
            regressionCount: 0,
            ...overrides,
        });

        const closedTask = (status = 'done') => ({
            id: 'task-9',
            slug: 'T-9',
            status,
            tenantId: 'tenant-1',
            organizationId: 'org-1',
        });

        const reopened = (overrides: Partial<IngestedEvent> = {}) =>
            storedEvent({
                id: 'row-r1',
                sourceEventId: 'issue:octo/site#42@reopened:2026-09-05T08:00:00.000Z',
                occurredAt: new Date('2026-09-05T08:00:00.000Z'),
                payload: { ...storedEvent().payload, action: 'reopened', state: 'open' },
                ...overrides,
            });

        /**
         * The headline property, driven through the real `process()` with
         * a stateful link store rather than asserted on a fixture: a
         * Sentry issue that alerts over and over is ONE Task, however
         * loud it gets. Each alert is a genuinely distinct ingested row
         * (Sentry mints a new `sourceEventId` per alerting event), so the
         * spine's own dedupe cannot be what saves us here — the link row
         * is.
         */
        it('files ONE Task for an issue that alerts twenty-five times', async () => {
            const { filer, tasks, links, taskRows, chat } = build();
            let stored: Record<string, unknown> | null = null;
            links.find.mockImplementation(async () => stored);
            links.link.mockImplementation(async (input: Record<string, unknown>) => {
                stored = { id: 'link-1', ...(stored ?? {}), ...input };
                return stored;
            });
            taskRows.findByIdAndUser.mockImplementation(async (taskId: string) =>
                stored && stored.taskId === taskId
                    ? {
                          id: taskId,
                          slug: 'T-2',
                          status: 'in_progress',
                          tenantId: 'tenant-1',
                          organizationId: 'org-1',
                      }
                    : null,
            );

            for (let i = 0; i < 25; i += 1) {
                await filer.process(
                    sentryEvent({
                        id: `row-a${i}`,
                        sourceEventId: `event_alert:4501:evt-${i}`,
                        payload: {
                            ...(sentryEvent().payload as Record<string, unknown>),
                            resource: 'event_alert',
                            action: 'triggered',
                            eventId: `evt-${i}`,
                        },
                    }),
                );
            }

            expect(tasks.create).toHaveBeenCalledTimes(1);
            // ...and the comment stream is NOT twenty-four rows deep.
            // Every alert carries the same instant and the same facts, so
            // they all land in one coalescing bucket. A Task comment is
            // not free — a chat row, a TASK_COMMENTED activity row, and a
            // Memory write per call — so commenting on every alert moved
            // the pager from the board into the comment stream and the
            // drain rather than closing it.
            expect(chat.post).not.toHaveBeenCalled();
            expect(stored).toMatchObject({ taskId: 'task-1', lastIngestedEventId: 'row-a24' });
        });

        it('coalesces repeat-alert comments to one per bucket, and never coalesces a CHANGE', async () => {
            const { filer, links, taskRows, chat } = build();
            let stored: Record<string, unknown> | null = null;
            links.find.mockImplementation(async () => stored);
            links.link.mockImplementation(async (input: Record<string, unknown>) => {
                stored = { id: 'link-1', ...(stored ?? {}), ...input };
                return stored;
            });
            taskRows.findByIdAndUser.mockImplementation(async (taskId: string) =>
                stored && stored.taskId === taskId
                    ? {
                          id: taskId,
                          slug: 'T-2',
                          status: 'in_progress',
                          tenantId: 'tenant-1',
                          organizationId: 'org-1',
                      }
                    : null,
            );

            const alertAt = (minutes: number) =>
                sentryEvent({
                    id: `row-b${minutes}`,
                    sourceEventId: `event_alert:4501:bucket-${minutes}`,
                    occurredAt: new Date(Date.UTC(2026, 8, 1, 12, minutes)),
                    payload: {
                        ...(sentryEvent().payload as Record<string, unknown>),
                        resource: 'event_alert',
                        action: 'triggered',
                    },
                });

            await filer.process(alertAt(0)); // files the Task
            await filer.process(alertAt(1)); // same bucket → silent
            await filer.process(alertAt(2)); // same bucket → silent
            expect(chat.post).not.toHaveBeenCalled();

            await filer.process(alertAt(20)); // next bucket → one comment
            expect(chat.post).toHaveBeenCalledTimes(1);

            await filer.process(alertAt(21)); // same bucket again → silent
            expect(chat.post).toHaveBeenCalledTimes(1);

            // A state CHANGE is never coalesced, whatever bucket it is in.
            await filer.process(
                sentryEvent({
                    id: 'row-b-resolved',
                    sourceEventId: 'issue:4501:resolved:2026-09-01T12:22:00.000Z',
                    occurredAt: new Date(Date.UTC(2026, 8, 1, 12, 22)),
                    payload: {
                        ...(sentryEvent().payload as Record<string, unknown>),
                        resource: 'issue',
                        action: 'resolved',
                        status: 'resolved',
                    },
                }),
            );
            expect(chat.post).toHaveBeenCalledTimes(2);
        });

        it('files a NEW Task when a reopened issue finds its Task already closed', async () => {
            const { filer, tasks, links, taskRows } = build();
            links.find.mockResolvedValue(link());
            taskRows.findByIdAndUser.mockResolvedValue(closedTask());

            const result = await filer.process(reopened());

            expect(result).toEqual({
                outcome: 'refiled',
                taskId: 'task-1',
                supersededTaskId: 'task-9',
                regressionCount: 1,
                signal: 'github.reopened',
            });
            expect(tasks.create).toHaveBeenCalledTimes(1);
            const [, input, scope] = tasks.create.mock.calls[0];
            expect(input.title).toBe(
                '[octo/site#42] Regression: Login button does nothing on Safari',
            );
            expect(input.labels).toEqual([TRIAGE_LABEL, 'source:github', 'regression']);
            expect(input.description).toContain('**Filed automatically as a regression**');
            expect(input.description).toContain('`T-9`');
            expect(input.workId).toBe('work-1');
            expect(scope).toEqual(SCOPE);
        });

        it('re-points the SAME dedup key at the new Task and counts the re-opening', async () => {
            const { filer, links, taskRows } = build();
            links.find.mockResolvedValue(link({ regressionCount: 2 }));
            taskRows.findByIdAndUser.mockResolvedValue(closedTask('cancelled'));

            const result = await filer.process(reopened());

            expect(result).toMatchObject({ outcome: 'refiled', regressionCount: 3 });
            expect(links.link).toHaveBeenCalledTimes(1);
            expect(links.link).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    source: 'github',
                    // The key itself never moves — only what it points at.
                    externalIssueId: 'octo/site#42',
                    taskId: 'task-1',
                    regressionCount: 3,
                    lastIngestedEventId: 'row-r1',
                }),
            );
        });

        it('leaves a two-way trail: one comment on the closed Task naming its replacement', async () => {
            const { filer, chat, links, taskRows } = build();
            links.find.mockResolvedValue(link());
            taskRows.findByIdAndUser.mockResolvedValue(closedTask());

            await filer.process(reopened());

            expect(chat.post).toHaveBeenCalledTimes(1);
            const [userId, post, , scope] = chat.post.mock.calls[0];
            expect(userId).toBe('user-1');
            expect(post.taskId).toBe('task-9');
            expect(post.body).toContain('**GitHub issue regressed**');
            // The build() stub's slug for the first Task it mints.
            expect(post.body).toContain('`T-2`');
            expect(scope).toEqual(SCOPE);
        });

        it('does NOT fork the board when the Task is still open — regression or not', async () => {
            const { filer, tasks, links, taskRows, chat } = build();
            links.find.mockResolvedValue(link());
            taskRows.findByIdAndUser.mockResolvedValue({
                ...closedTask('in_progress'),
            });

            const result = await filer.process(reopened());

            expect(result).toEqual({ outcome: 'updated', taskId: 'task-9', commented: true });
            expect(tasks.create).not.toHaveBeenCalled();
            expect(chat.post.mock.calls[0][1].body).toContain('- **Regression** —');
            expect(links.link).toHaveBeenCalledWith(
                expect.not.objectContaining({ regressionCount: expect.anything() }),
            );
        });

        const repeatAlert = (overrides: Partial<IngestedEvent> = {}) =>
            sentryEvent({
                id: 'row-s9',
                sourceEventId: 'event_alert:4501:evt-77',
                payload: {
                    ...(sentryEvent().payload as Record<string, unknown>),
                    resource: 'event_alert',
                    action: 'triggered',
                    eventId: 'evt-77',
                },
                ...overrides,
            });

        it('a repeated Sentry alert on an OPEN Task files nothing — it is not a regression', async () => {
            const { filer, tasks, links, taskRows } = build();
            links.find.mockResolvedValue(link({ source: 'sentry', externalIssueId: '4501' }));
            taskRows.findByIdAndUser.mockResolvedValue({
                ...closedTask(),
                status: 'in_progress',
            });

            const result = await filer.process(repeatAlert());

            expect(result).toMatchObject({ outcome: 'updated', taskId: 'task-9' });
            expect(tasks.create).not.toHaveBeenCalled();
        });

        /**
         * The rule this replaces said an `event_alert` is never a
         * regression, full stop. That made the vendor's explicit
         * regression signal a ONE-SHOT: `triageRegressionOf` is a pure
         * function of a single event, so if the filer could not act on
         * the one `issue.unresolved` that carried it (the Work claim had
         * just been removed, the body was refused), every later delivery
         * was an `event_alert` and the closed Task could never be
         * superseded — the regression was permanently downgraded to a
         * comment on a Task nobody reads, which is the exact failure the
         * regression feature exists to prevent.
         *
         * An error still firing after somebody marked the work DONE is a
         * regression by any honest reading, and unlike the vendor signal
         * it is re-carried by every subsequent alert. It is still ONE
         * Task: the re-file leaves an OPEN Task, so the alert after it
         * takes the ordinary comment path (asserted above).
         */
        it('a repeated Sentry alert re-opens work when the Task was marked DONE', async () => {
            const { filer, tasks, links, taskRows } = build();
            links.find.mockResolvedValue(link({ source: 'sentry', externalIssueId: '4501' }));
            taskRows.findByIdAndUser.mockResolvedValue(closedTask('done'));

            const result = await filer.process(repeatAlert());

            expect(result).toMatchObject({
                outcome: 'refiled',
                signal: 'sentry.still-active',
                supersededTaskId: 'task-9',
                regressionCount: 1,
            });
            expect(tasks.create).toHaveBeenCalledTimes(1);
        });

        it('a repeated Sentry alert NEVER re-opens a CANCELLED Task — that was a human decision', async () => {
            const { filer, tasks, links, taskRows } = build();
            links.find.mockResolvedValue(link({ source: 'sentry', externalIssueId: '4501' }));
            taskRows.findByIdAndUser.mockResolvedValue(closedTask('cancelled'));

            const result = await filer.process(repeatAlert());

            expect(result).toMatchObject({ outcome: 'updated', taskId: 'task-9' });
            expect(tasks.create).not.toHaveBeenCalled();
        });

        it('files a new Task for a Sentry issue that regressed after its Task was closed', async () => {
            const { filer, tasks, links, taskRows } = build();
            links.find.mockResolvedValue(link({ source: 'sentry', externalIssueId: '4501' }));
            taskRows.findByIdAndUser.mockResolvedValue(closedTask());
            const regressed = sentryEvent({
                id: 'row-s10',
                sourceEventId: 'issue:4501:unresolved:2026-09-05T08:00:00.000Z',
                payload: {
                    ...(sentryEvent().payload as Record<string, unknown>),
                    action: 'unresolved',
                    status: 'unresolved',
                },
            });

            const result = await filer.process(regressed);

            expect(result).toMatchObject({
                outcome: 'refiled',
                signal: 'sentry.unresolved',
                supersededTaskId: 'task-9',
            });
            expect(tasks.create).toHaveBeenCalledTimes(1);
            expect(tasks.create.mock.calls[0][1].labels).toEqual([
                TRIAGE_LABEL,
                'source:sentry',
                'regression',
            ]);
        });

        /**
         * `refile()` routes an EXISTING dedup row through `file()`, which
         * writes `url: facts.url ?? null`. Before this slice `file()` only
         * ever INSERTED, so the `?? null` was harmless; sending an
         * existing row down the same path made it destructive — a
         * revision that happens to omit the deep link (a Jira transition
         * with no `issue.self`, a Sentry issue whose permalink will not
         * parse) NULLed a link the row already had. Every existing
         * assertion used `objectContaining`, which is blind to a field
         * being nulled, so nothing caught it.
         */
        it('a regression that carries no url keeps the one the link already had', async () => {
            const { filer, links, taskRows } = build();
            links.find.mockResolvedValue(
                link({
                    source: 'sentry',
                    externalIssueId: '4501',
                    url: 'https://sentry.io/organizations/ever-co/issues/4501/',
                    externalKey: 'EVER-WORKS-1X',
                }),
            );
            taskRows.findByIdAndUser.mockResolvedValue(closedTask());

            await filer.process(
                sentryEvent({
                    id: 'row-s11',
                    sourceEventId: 'issue:4501:unresolved:2026-09-05T09:00:00.000Z',
                    sourceUrl: null,
                    payload: {
                        provider: 'sentry',
                        externalId: '4501',
                        title: 'TypeError: Cannot read properties of undefined',
                        resource: 'issue',
                        action: 'unresolved',
                        status: 'unresolved',
                    },
                }),
            );

            const written = links.link.mock.calls.at(-1)?.[0];
            // Exact assertions — `objectContaining` cannot see a null.
            expect(written.url).toBe('https://sentry.io/organizations/ever-co/issues/4501/');
            // The event carries its own key here, so that one wins; the
            // stored one is the FALLBACK, not an override.
            expect(written.externalKey).toBe('4501');
        });

        it('keeps the stored externalKey when the revision carries none at all', async () => {
            const { filer, links, taskRows } = build();
            links.find.mockResolvedValue(
                link({ source: 'jira-connector', externalIssueId: '10001', externalKey: 'ENG-42' }),
            );
            taskRows.findByIdAndUser.mockResolvedValue(closedTask());

            await filer.process(
                storedEvent({
                    id: 'row-j1',
                    source: 'jira-connector',
                    kind: 'jira.issue',
                    subjectExternalId: '10001',
                    sourceUrl: null,
                    payload: {
                        // No `issueKey` → `triageExternalKeyOf` yields null.
                        changeType: 'transitioned',
                        statusFrom: 'Done',
                        statusTo: 'In Progress',
                        title: 'Login broken',
                    },
                }),
            );

            const written = links.link.mock.calls.at(-1)?.[0];
            expect(written.externalKey).toBe('ENG-42');
            expect(written.url).toBe('https://github.com/octo/site/issues/42');
        });

        it('a drain retry of the same regression row files nothing a second time', async () => {
            const { filer, tasks, links, taskRows, chat } = build();
            links.find.mockResolvedValue(link({ lastIngestedEventId: 'row-r1', taskId: 'task-7' }));

            const result = await filer.process(reopened());

            expect(result).toEqual({ outcome: 'noop', taskId: 'task-7' });
            expect(taskRows.findByIdAndUser).not.toHaveBeenCalled();
            expect(tasks.create).not.toHaveBeenCalled();
            expect(chat.post).not.toHaveBeenCalled();
            expect(links.link).not.toHaveBeenCalled();
        });

        it('falls back to commenting when the regression cannot be filed (Work gone) — never silently dropped', async () => {
            const { filer, tasks, links, works, taskRows, chat } = build();
            links.find.mockResolvedValue(link());
            taskRows.findByIdAndUser.mockResolvedValue(closedTask());
            works.findById.mockResolvedValue(null);

            const result = await filer.process(reopened());

            expect(result).toEqual({ outcome: 'updated', taskId: 'task-9', commented: true });
            expect(tasks.create).not.toHaveBeenCalled();
            expect(chat.post.mock.calls[0][1].body).toContain('- **Regression** —');
            expect(links.link).toHaveBeenCalledWith(
                expect.objectContaining({ taskId: 'task-9', lastIngestedEventId: 'row-r1' }),
            );
        });

        it('still re-files when the note on the superseded Task is refused', async () => {
            const { filer, tasks, links, taskRows, chat } = build();
            links.find.mockResolvedValue(link());
            taskRows.findByIdAndUser.mockResolvedValue(closedTask());
            chat.post.mockRejectedValue(new BadRequestException('Chat body exceeds max'));

            const result = await filer.process(reopened());

            expect(result).toMatchObject({ outcome: 'refiled', taskId: 'task-1' });
            expect(tasks.create).toHaveBeenCalledTimes(1);
            expect(links.link).toHaveBeenCalledWith(
                expect.objectContaining({ taskId: 'task-1', regressionCount: 1 }),
            );
        });
    });
});

import {
    ExternalIssueLinkService,
    ExternalIssueLinkOwnershipError,
    externalIssueIdOf,
} from '../external-issue-link.service';
import type { ExternalIssueLinkRepository } from '../external-issue-link.repository';
import type { TaskRepository } from '../../database/repositories/task.repository';
import type { IngestedEvent } from '../../entities/ingested-event.entity';

/**
 * External-issue ↔ Task mapping (audit item (i)).
 *
 * The load-bearing assertions:
 *   - a link is NEVER written for a Task the caller does not own (the
 *     schema carries no cross-entity FK, so this check is the only guard);
 *   - the ingest drain never CREATES a link — binding an issue to a Task
 *     stays a deliberate act, so ingest can only refresh what exists.
 */

const storedEvent = (overrides: Partial<IngestedEvent> = {}): IngestedEvent =>
    ({
        id: 'row-1',
        userId: 'user-1',
        organizationId: null,
        workId: null,
        source: 'linear-connector',
        sourceEventId: 'issue-42:2026-07-24T10:00:00.000Z',
        kind: 'linear.issue',
        occurredAt: new Date('2026-07-24T10:00:00.000Z'),
        actorName: 'Ada',
        subjectType: 'issue',
        subjectExternalId: 'issue-42',
        title: 'Fix the flaky sweep',
        sourceUrl: 'https://linear.app/acme/issue/ENG-42',
        payload: {},
        processedAt: null,
        dedupeKey: 'abc',
        createdAt: new Date('2026-07-24T10:00:05.000Z'),
        ...overrides,
    }) as IngestedEvent;

describe('ExternalIssueLinkService', () => {
    let links: {
        findByExternal: jest.Mock;
        findByTask: jest.Mock;
        findByUser: jest.Mock;
        upsert: jest.Mock;
        touch: jest.Mock;
        unlink: jest.Mock;
    };
    let tasks: { findByIdAndUser: jest.Mock };

    const build = (withTasks = true) =>
        new ExternalIssueLinkService(
            links as unknown as ExternalIssueLinkRepository,
            withTasks ? (tasks as unknown as TaskRepository) : undefined,
        );

    beforeEach(() => {
        links = {
            findByExternal: jest.fn(async () => null),
            findByTask: jest.fn(async () => []),
            findByUser: jest.fn(async () => []),
            upsert: jest.fn(async (data) => ({ id: 'link-1', ...data })),
            touch: jest.fn(async () => ({ id: 'link-1' })),
            unlink: jest.fn(async () => true),
        };
        tasks = { findByIdAndUser: jest.fn(async () => ({ id: 'task-1', userId: 'user-1' })) };
    });

    describe('link', () => {
        it('binds the issue to the Task after the ownership check passes', async () => {
            const link = await build().link({
                userId: 'user-1',
                taskId: 'task-1',
                source: 'linear-connector',
                externalIssueId: 'issue-42',
                externalKey: 'ENG-42',
                title: 'Fix the flaky sweep',
                url: 'https://linear.app/acme/issue/ENG-42',
            });

            expect(tasks.findByIdAndUser).toHaveBeenCalledWith('task-1', 'user-1');
            expect(links.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    taskId: 'task-1',
                    source: 'linear-connector',
                    externalIssueId: 'issue-42',
                    externalKey: 'ENG-42',
                }),
            );
            expect(link).toMatchObject({ id: 'link-1', taskId: 'task-1' });
        });

        it('⭐ refuses to link a Task the caller does not own — and never writes', async () => {
            tasks.findByIdAndUser.mockResolvedValue(null);

            await expect(
                build().link({
                    userId: 'attacker',
                    taskId: 'someone-elses-task',
                    source: 'linear-connector',
                    externalIssueId: 'issue-42',
                }),
            ).rejects.toMatchObject({ name: 'ExternalIssueLinkOwnershipError' });

            expect(links.upsert).not.toHaveBeenCalled();
        });

        it('refuses when the Tasks feature is not wired — cannot prove ownership, so does not guess', async () => {
            await expect(
                build(false).link({
                    userId: 'user-1',
                    taskId: 'task-1',
                    source: 'linear-connector',
                    externalIssueId: 'issue-42',
                }),
            ).rejects.toBeInstanceOf(ExternalIssueLinkOwnershipError);
            expect(links.upsert).not.toHaveBeenCalled();
        });

        /**
         * The triage intake files a Task and binds the issue in ONE step,
         * stamping the ingested event id it acted on so a drain retry of
         * that same row can recognise itself. The fields only travel when
         * the caller sets them — an ordinary `link()` from the API leaves
         * the breadcrumbs to the drain.
         */
        it('passes freshness breadcrumbs through when a server-side filer stamps them', async () => {
            const lastSeenAt = new Date('2026-09-01T09:00:00.000Z');
            await build().link({
                userId: 'user-1',
                taskId: 'task-1',
                source: 'github',
                externalIssueId: 'octo/site#42',
                lastIngestedEventId: 'row-7',
                lastSeenAt,
            });
            expect(links.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ lastIngestedEventId: 'row-7', lastSeenAt }),
            );
        });

        it('leaves the freshness breadcrumbs untouched when the caller does not set them', async () => {
            await build().link({
                userId: 'user-1',
                taskId: 'task-1',
                source: 'github',
                externalIssueId: 'octo/site#42',
            });
            const written = links.upsert.mock.calls[0][0];
            expect(written).not.toHaveProperty('lastIngestedEventId');
            expect(written).not.toHaveProperty('lastSeenAt');
            // The regression counter is state, not a breadcrumb: an
            // ordinary link must never reset somebody's history to 0.
            expect(written).not.toHaveProperty('regressionCount');
        });

        it('carries the re-opening count when a regression re-points the link', async () => {
            await build().link({
                userId: 'user-1',
                taskId: 'task-1',
                source: 'github',
                externalIssueId: 'octo/site#42',
                regressionCount: 3,
            });
            expect(links.upsert).toHaveBeenCalledWith(
                expect.objectContaining({ regressionCount: 3 }),
            );
        });

        it('normalizes absent optional labels to null so an upsert clears stale values', async () => {
            await build().link({
                userId: 'user-1',
                taskId: 'task-1',
                source: 'jira-connector',
                externalIssueId: 'ISSUE-9',
            });
            expect(links.upsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    externalKey: null,
                    title: null,
                    url: null,
                    tenantId: null,
                    organizationId: null,
                }),
            );
        });
    });

    describe('resolveTaskId / listForTask / unlink', () => {
        it('resolves the linked Task for an owner-scoped external issue', async () => {
            links.findByExternal.mockResolvedValue({ taskId: 'task-7' });
            await expect(
                build().resolveTaskId('user-1', 'linear-connector', 'issue-42'),
            ).resolves.toBe('task-7');
            expect(links.findByExternal).toHaveBeenCalledWith(
                'user-1',
                'linear-connector',
                'issue-42',
            );
        });

        it('find returns the whole owner-scoped row (the triage filer reads taskId + lastIngestedEventId)', async () => {
            const row = { id: 'link-1', taskId: 'task-1', lastIngestedEventId: 'row-7' };
            links.findByExternal.mockResolvedValue(row);
            await expect(build().find('user-1', 'github', 'octo/site#42')).resolves.toBe(row);
            expect(links.findByExternal).toHaveBeenCalledWith('user-1', 'github', 'octo/site#42');
        });

        it('resolves to null when the issue is not linked', async () => {
            await expect(
                build().resolveTaskId('user-1', 'linear-connector', 'issue-42'),
            ).resolves.toBeNull();
        });

        it('lists every issue mirrored by a Task', async () => {
            links.findByTask.mockResolvedValue([{ id: 'link-1' }, { id: 'link-2' }]);
            await expect(build().listForTask('task-1')).resolves.toHaveLength(2);
        });

        it('unlink delegates owner-scoped', async () => {
            await expect(build().unlink('user-1', 'linear-connector', 'issue-42')).resolves.toBe(
                true,
            );
            expect(links.unlink).toHaveBeenCalledWith('user-1', 'linear-connector', 'issue-42');
        });
    });

    describe('recordEvent (ingest drain hook)', () => {
        it('refreshes an existing link with the event id, timestamp, title and url', async () => {
            await build().recordEvent(storedEvent());

            expect(links.touch).toHaveBeenCalledWith('user-1', 'linear-connector', 'issue-42', {
                lastIngestedEventId: 'row-1',
                lastSeenAt: new Date('2026-07-24T10:00:00.000Z'),
                title: 'Fix the flaky sweep',
                url: 'https://linear.app/acme/issue/ENG-42',
            });
        });

        it('⭐ a COMMENT on a linked issue stamps freshness but never rewrites the issue url', async () => {
            // Tracker connectors give comment events the parent ISSUE as
            // their subject, which is how they reach this method — but
            // their sourceUrl is the comment permalink. Writing it onto
            // the link would replace the canonical issue link with a deep
            // link to one reply.
            await build().recordEvent(
                storedEvent({
                    kind: 'linear.comment',
                    sourceUrl: 'https://linear.app/acme/issue/ENG-42#comment-9',
                }),
            );

            expect(links.touch).toHaveBeenCalledWith('user-1', 'linear-connector', 'issue-42', {
                lastIngestedEventId: 'row-1',
                lastSeenAt: new Date('2026-07-24T10:00:00.000Z'),
            });
        });

        it('⭐ never CREATES a link — an unlinked issue is a no-op', async () => {
            links.touch.mockResolvedValue(null);
            await expect(build().recordEvent(storedEvent())).resolves.toBeNull();
            expect(links.upsert).not.toHaveBeenCalled();
        });

        it('ignores non-issue events entirely (no repository round-trip)', async () => {
            const chat = storedEvent({
                kind: 'slack.message',
                subjectType: 'channel',
                subjectExternalId: 'C123',
            });
            await expect(build().recordEvent(chat)).resolves.toBeNull();
            expect(links.touch).not.toHaveBeenCalled();
        });

        it('tryRecordEvent swallows repository failures — the drain must never fail on it', async () => {
            links.touch.mockRejectedValue(new Error('db down'));
            await expect(build().tryRecordEvent(storedEvent())).resolves.toBe(false);
        });

        it('tryRecordEvent reports true only when a link was actually touched', async () => {
            await expect(build().tryRecordEvent(storedEvent())).resolves.toBe(true);
            links.touch.mockResolvedValue(null);
            await expect(build().tryRecordEvent(storedEvent())).resolves.toBe(false);
        });
    });
});

describe('externalIssueIdOf', () => {
    it('uses subject.externalId — NOT sourceEventId, which carries a revision suffix', () => {
        // `linear-connector` builds `${issue.id}:${updatedAt}`; joining on
        // that would produce a new "issue" on every single update.
        const event = storedEvent();
        expect(event.sourceEventId).toContain(':');
        expect(externalIssueIdOf(event)).toBe('issue-42');
    });

    it('recognises issue-shaped subject types', () => {
        for (const subjectType of ['issue', 'ticket', 'story', 'bug', 'ISSUE']) {
            expect(externalIssueIdOf(storedEvent({ subjectType, kind: 'x.thing' }))).toBe(
                'issue-42',
            );
        }
    });

    it('falls back to the kind when the connector does not type the subject', () => {
        expect(
            externalIssueIdOf(storedEvent({ subjectType: null, kind: 'github.issues.opened' })),
        ).toBe('issue-42');
    });

    it('returns undefined for non-issue events and for events without a subject id', () => {
        expect(
            externalIssueIdOf(storedEvent({ subjectType: 'channel', kind: 'slack.message' })),
        ).toBeUndefined();
        expect(externalIssueIdOf(storedEvent({ subjectExternalId: null }))).toBeUndefined();
    });
});

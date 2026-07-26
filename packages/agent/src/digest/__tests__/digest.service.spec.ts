import { DigestService } from '../digest.service';
import { TaskStatus } from '../../entities/task.entity';
import { GoalStatus } from '../../entities/goal.entity';

/**
 * Digest briefings (Wave 7) — composer/delivery/dispatcher unit specs
 * over mocked repositories (house pattern: plain-object mocks + `as
 * any` construction, mirroring event-ingest.service.spec).
 */

const NOW = new Date('2026-07-25T07:15:00.000Z');

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const daysAgo = (d: number) => hoursAgo(d * 24);

describe('DigestService', () => {
    let userRepository: {
        findById: jest.Mock;
        findByDigestFrequency: jest.Mock;
    };
    let taskRepository: { findByUserIdFiltered: jest.Mock };
    let agentRunRepository: { listSessionsForUser: jest.Mock };
    let ingestedEventRepository: { findRecentByUser: jest.Mock };
    let notificationService: { notifyDigest: jest.Mock };
    let goalsService: { listForUser: jest.Mock };
    let escalationService: { listOpenForUser: jest.Mock };

    const build = (opts: { withGoals?: boolean; withEscalations?: boolean } = {}) =>
        new DigestService(
            userRepository as any,
            taskRepository as any,
            agentRunRepository as any,
            ingestedEventRepository as any,
            notificationService as any,
            opts.withGoals === false ? undefined : (goalsService as any),
            opts.withEscalations === false ? undefined : (escalationService as any),
        );

    beforeEach(() => {
        userRepository = {
            findById: jest.fn().mockResolvedValue({ id: 'user-1', digestFrequency: 'daily' }),
            findByDigestFrequency: jest.fn().mockResolvedValue([]),
        };
        taskRepository = {
            findByUserIdFiltered: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
        };
        agentRunRepository = {
            listSessionsForUser: jest.fn().mockResolvedValue([[], 0]),
        };
        ingestedEventRepository = {
            findRecentByUser: jest.fn().mockResolvedValue([]),
        };
        notificationService = { notifyDigest: jest.fn().mockResolvedValue(undefined) };
        goalsService = { listForUser: jest.fn().mockResolvedValue([]) };
        escalationService = { listOpenForUser: jest.fn().mockResolvedValue([]) };
    });

    describe('composeDigest', () => {
        it('counts completed and failed agent runs inside the window and renders them', async () => {
            agentRunRepository.listSessionsForUser.mockResolvedValue([
                [
                    {
                        id: 'run-ok',
                        status: 'completed',
                        finishedAt: hoursAgo(2),
                        createdAt: hoursAgo(3),
                        summary: 'Shipped the landing page copy',
                    },
                    {
                        id: 'run-bad',
                        status: 'failed',
                        finishedAt: hoursAgo(1),
                        createdAt: hoursAgo(2),
                        errorMessage: 'Build exploded',
                    },
                    // Non-terminal — never counted.
                    { id: 'run-live', status: 'running', createdAt: hoursAgo(1) },
                ],
                3,
            ]);

            const digest = await build().composeDigest('user-1', { period: 'daily', now: NOW });

            expect(digest.counts.runsCompleted).toBe(1);
            expect(digest.counts.runsFailed).toBe(1);
            expect(digest.quiet).toBe(false);
            expect(digest.markdown).toContain('## Agent runs');
            expect(digest.markdown).toContain('Completed: Shipped the landing page copy');
            expect(digest.markdown).toContain('Failed: Build exploded');
            expect(digest.text).toContain('1 agent run completed (1 failed)');
        });

        it('excludes runs that finished before the daily window', async () => {
            agentRunRepository.listSessionsForUser.mockResolvedValue([
                [
                    {
                        id: 'run-old',
                        status: 'completed',
                        finishedAt: daysAgo(2),
                        createdAt: daysAgo(2),
                        summary: 'Old news',
                    },
                ],
                1,
            ]);

            const digest = await build().composeDigest('user-1', { period: 'daily', now: NOW });

            expect(digest.counts.runsCompleted).toBe(0);
            expect(digest.quiet).toBe(true);
        });

        it('counts tasks moved to done and in-review inside the window only', async () => {
            taskRepository.findByUserIdFiltered.mockResolvedValue({
                rows: [
                    {
                        id: 't1',
                        title: 'Ship digest',
                        status: TaskStatus.DONE,
                        updatedAt: hoursAgo(3),
                    },
                    {
                        id: 't2',
                        title: 'Review gates',
                        status: TaskStatus.IN_REVIEW,
                        updatedAt: hoursAgo(5),
                    },
                    // Outside the daily window.
                    { id: 't3', title: 'Stale', status: TaskStatus.DONE, updatedAt: daysAgo(3) },
                    // In-window but not a digest-relevant status.
                    {
                        id: 't4',
                        title: 'WIP',
                        status: TaskStatus.IN_PROGRESS,
                        updatedAt: hoursAgo(1),
                    },
                ],
                total: 4,
            });

            const digest = await build().composeDigest('user-1', { period: 'daily', now: NOW });

            expect(digest.counts.tasksDone).toBe(1);
            expect(digest.counts.tasksInReview).toBe(1);
            expect(digest.markdown).toContain('Done: Ship digest');
            expect(digest.markdown).toContain('In review: Review gates');
        });

        it('lists PRs opened by agents from tasks.prUrl within the window', async () => {
            taskRepository.findByUserIdFiltered.mockResolvedValue({
                rows: [
                    {
                        id: 't1',
                        title: 'Digest composer',
                        status: TaskStatus.IN_REVIEW,
                        updatedAt: hoursAgo(4),
                        prUrl: 'https://github.com/acme/repo/pull/7',
                    },
                    {
                        id: 't2',
                        title: 'Old PR',
                        status: TaskStatus.DONE,
                        updatedAt: daysAgo(4),
                        prUrl: 'https://github.com/acme/repo/pull/1',
                    },
                ],
                total: 2,
            });

            const digest = await build().composeDigest('user-1', { period: 'daily', now: NOW });

            expect(digest.counts.prsOpened).toBe(1);
            expect(digest.markdown).toContain(
                '[Digest composer](https://github.com/acme/repo/pull/7)',
            );
            expect(digest.markdown).not.toContain('pull/1');
        });

        it('aggregates ingested-event counts by source', async () => {
            ingestedEventRepository.findRecentByUser.mockResolvedValue([
                { source: 'slack-connector', occurredAt: hoursAgo(1) },
                { source: 'slack-connector', occurredAt: hoursAgo(2) },
                { source: 'github', occurredAt: hoursAgo(3) },
                // Outside the window — dropped.
                { source: 'github', occurredAt: daysAgo(2) },
            ]);

            const digest = await build().composeDigest('user-1', { period: 'daily', now: NOW });

            expect(digest.counts.eventsBySource).toEqual({ 'slack-connector': 2, github: 1 });
            expect(digest.counts.eventsTotal).toBe(3);
            expect(digest.markdown).toContain('- slack-connector: 2 events');
            expect(digest.markdown).toContain('- github: 1 event');
        });

        it('includes an active-goal progress snapshot when GoalsService is bound', async () => {
            goalsService.listForUser.mockResolvedValue([
                {
                    id: 'g1',
                    title: 'Weekly visitors',
                    currentValue: 420,
                    targetValue: 1000,
                    unit: 'visits',
                },
            ]);

            const digest = await build().composeDigest('user-1', { period: 'daily', now: NOW });

            expect(goalsService.listForUser).toHaveBeenCalledWith('user-1', {
                status: GoalStatus.ACTIVE,
                limit: expect.any(Number),
            });
            expect(digest.counts.goalsTracked).toBe(1);
            expect(digest.markdown).toContain('- Weekly visitors: 420 / 1000 visits');
        });

        it('⭐ leads with open escalations — the only digest item blocking on a human', async () => {
            // Judgment layer G3. Everything else in a digest is a report;
            // an escalation is a request. Burying it under run counts is
            // how a stopped agent goes unnoticed for a week.
            escalationService.listOpenForUser.mockResolvedValue([
                {
                    id: 'e1',
                    reasonCode: 'gate-exhausted',
                    summary: 'Checks still red after 2 attempts.',
                    decisionNeeded: 'Fix by hand or raise the attempt budget.',
                },
            ]);

            const digest = await build().composeDigest('user-1', { period: 'daily', now: NOW });

            expect(digest.counts.escalationsOpen).toBe(1);
            expect(digest.markdown).toContain('## Needs your decision');
            expect(digest.markdown).toContain('gate-exhausted');
            expect(digest.text).toContain('1 decision needed');
        });

        it('⭐ an escalation alone un-quiets the window, so the digest is not suppressed', async () => {
            // A window in which nothing happened BUT an agent stopped and
            // asked for a decision is the opposite of quiet — suppressing
            // it would hide exactly the signal the digest exists to carry.
            escalationService.listOpenForUser.mockResolvedValue([
                {
                    id: 'e1',
                    reasonCode: 'budget-stop',
                    summary: 'Budget cap reached mid-run.',
                    decisionNeeded: 'Raise the cap or stop the work.',
                },
            ]);

            const digest = await build().composeDigest('user-1', { period: 'daily', now: NOW });

            expect(digest.quiet).toBe(false);
        });

        it('composes without an escalation section when the service is not wired', async () => {
            const digest = await build({ withEscalations: false }).composeDigest('user-1', {
                period: 'daily',
                now: NOW,
            });
            expect(digest.counts.escalationsOpen).toBe(0);
            expect(digest.markdown).not.toContain('## Needs your decision');
        });

        it('still composes when the escalation lookup throws', async () => {
            escalationService.listOpenForUser.mockRejectedValue(new Error('db down'));
            const digest = await build().composeDigest('user-1', { period: 'daily', now: NOW });
            expect(digest.counts.escalationsOpen).toBe(0);
        });

        it('composes without a goals section when GoalsService is not wired', async () => {
            const digest = await build({ withGoals: false }).composeDigest('user-1', {
                period: 'daily',
                now: NOW,
            });

            expect(digest.counts.goalsTracked).toBe(0);
            expect(digest.markdown).not.toContain('## Goal progress');
        });

        it('weekly window spans 7 days where daily spans 24 hours', async () => {
            taskRepository.findByUserIdFiltered.mockResolvedValue({
                rows: [
                    {
                        id: 't1',
                        title: 'Three days old',
                        status: TaskStatus.DONE,
                        updatedAt: daysAgo(3),
                    },
                ],
                total: 1,
            });

            const svc = build();
            const daily = await svc.composeDigest('user-1', { period: 'daily', now: NOW });
            const weekly = await svc.composeDigest('user-1', { period: 'weekly', now: NOW });

            expect(daily.counts.tasksDone).toBe(0);
            expect(weekly.counts.tasksDone).toBe(1);
        });

        it('renders the quiet empty state when the window has no activity', async () => {
            const digest = await build().composeDigest('user-1', { period: 'weekly', now: NOW });

            expect(digest.quiet).toBe(true);
            expect(digest.markdown).toContain('A quiet week');
            expect(digest.text).toBe('Weekly digest: a quiet week — no new activity.');
        });
    });

    describe('deliverDigest', () => {
        const seedActivity = () => {
            agentRunRepository.listSessionsForUser.mockResolvedValue([
                [
                    {
                        id: 'run-ok',
                        status: 'completed',
                        finishedAt: hoursAgo(2),
                        createdAt: hoursAgo(3),
                        summary: 'Did things',
                    },
                ],
                1,
            ]);
        };

        it('skips users whose digest preference is off and never notifies', async () => {
            userRepository.findById.mockResolvedValue({ id: 'user-1', digestFrequency: 'off' });
            seedActivity();

            const result = await build().deliverDigest('user-1', 'daily', { now: NOW });

            expect(result).toEqual({ delivered: false, reason: 'digest-off' });
            expect(notificationService.notifyDigest).not.toHaveBeenCalled();
        });

        it('skips period mismatches (weekly user, daily send) unless forced', async () => {
            userRepository.findById.mockResolvedValue({ id: 'user-1', digestFrequency: 'weekly' });
            seedActivity();
            const svc = build();

            const mismatch = await svc.deliverDigest('user-1', 'daily', { now: NOW });
            expect(mismatch).toEqual({ delivered: false, reason: 'period-mismatch' });

            const forced = await svc.deliverDigest('user-1', 'daily', { now: NOW, force: true });
            expect(forced.delivered).toBe(true);
            expect(notificationService.notifyDigest).toHaveBeenCalledTimes(1);
        });

        it('delivers via the notifications producer with a windowed dedup key', async () => {
            seedActivity();

            const result = await build().deliverDigest('user-1', 'daily', { now: NOW });

            expect(result.delivered).toBe(true);
            expect(notificationService.notifyDigest).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-1',
                    period: 'daily',
                    title: 'Your daily digest',
                    deduplicationKey: 'digest_daily_2026-07-25',
                    message: expect.stringContaining('Daily digest:'),
                    markdown: expect.stringContaining('# Your daily digest'),
                }),
            );
        });

        it('skips quiet windows instead of sending an empty briefing', async () => {
            const result = await build().deliverDigest('user-1', 'daily', { now: NOW });

            expect(result.delivered).toBe(false);
            expect(result.reason).toBe('quiet-period');
            expect(notificationService.notifyDigest).not.toHaveBeenCalled();
        });

        it('reports user-not-found without composing', async () => {
            userRepository.findById.mockResolvedValue(null);

            const result = await build().deliverDigest('ghost', 'daily', { now: NOW });

            expect(result).toEqual({ delivered: false, reason: 'user-not-found' });
            expect(agentRunRepository.listSessionsForUser).not.toHaveBeenCalled();
        });
    });

    describe('dispatchDue', () => {
        it('selects daily users via findByDigestFrequency and tallies outcomes', async () => {
            userRepository.findByDigestFrequency.mockResolvedValue([
                { id: 'u-active' },
                { id: 'u-quiet' },
                { id: 'u-broken' },
            ]);
            userRepository.findById.mockImplementation(async (id: string) => ({
                id,
                digestFrequency: 'daily',
            }));
            // u-active has a run in-window; u-quiet has nothing; u-broken throws.
            agentRunRepository.listSessionsForUser.mockImplementation(async (userId: string) => {
                if (userId === 'u-broken') throw new Error('db down');
                if (userId === 'u-active') {
                    return [
                        [
                            {
                                id: 'r1',
                                status: 'completed',
                                finishedAt: hoursAgo(1),
                                createdAt: hoursAgo(2),
                                summary: 'ok',
                            },
                        ],
                        1,
                    ];
                }
                return [[], 0];
            });

            const summary = await build().dispatchDue('daily', { now: NOW });

            expect(userRepository.findByDigestFrequency).toHaveBeenCalledWith(
                'daily',
                expect.any(Number),
            );
            expect(summary).toEqual({
                period: 'daily',
                selected: 3,
                delivered: 1,
                skippedQuiet: 1,
                skipped: 0,
                failed: 1,
            });
        });

        it('queries the weekly cohort for a weekly pass', async () => {
            userRepository.findByDigestFrequency.mockResolvedValue([]);

            const summary = await build().dispatchDue('weekly', { now: NOW, limit: 10 });

            expect(userRepository.findByDigestFrequency).toHaveBeenCalledWith('weekly', 10);
            expect(summary).toEqual({
                period: 'weekly',
                selected: 0,
                delivered: 0,
                skippedQuiet: 0,
                skipped: 0,
                failed: 0,
            });
        });
    });
});

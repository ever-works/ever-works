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
        update: jest.Mock;
    };
    let taskRepository: { findByUserIdFiltered: jest.Mock; findRecentByOrganization: jest.Mock };
    let agentRunRepository: {
        listSessionsForUser: jest.Mock;
        listRecentForOrganization: jest.Mock;
    };
    let ingestedEventRepository: {
        findRecentByUser: jest.Mock;
        findRecentByOrganization: jest.Mock;
    };
    let notificationService: { notifyDigest: jest.Mock };
    let goalsService: { listForUser: jest.Mock };
    let escalationService: { listOpenForUser: jest.Mock };
    let organizationRepository: {
        findById: jest.Mock;
        findWithDigestSettings: jest.Mock;
        update: jest.Mock;
    };
    let tenantRepository: { findById: jest.Mock };
    let aiFacade: { isConfigured: jest.Mock; createChatCompletion: jest.Mock };

    const build = (
        opts: {
            withGoals?: boolean;
            withEscalations?: boolean;
            withOrg?: boolean;
            withAi?: boolean;
        } = {},
    ) =>
        new DigestService(
            userRepository as any,
            taskRepository as any,
            agentRunRepository as any,
            ingestedEventRepository as any,
            notificationService as any,
            opts.withGoals === false ? undefined : (goalsService as any),
            opts.withEscalations === false ? undefined : (escalationService as any),
            opts.withOrg === false ? undefined : (organizationRepository as any),
            opts.withOrg === false ? undefined : (tenantRepository as any),
            // Default OFF: the pre-existing per-user specs must keep
            // passing on an install with no AI provider at all.
            opts.withAi === true ? (aiFacade as any) : undefined,
        );

    beforeEach(() => {
        userRepository = {
            findById: jest.fn().mockResolvedValue({ id: 'user-1', digestFrequency: 'daily' }),
            findByDigestFrequency: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue(undefined),
        };
        taskRepository = {
            findByUserIdFiltered: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
            findRecentByOrganization: jest.fn().mockResolvedValue([]),
        };
        agentRunRepository = {
            listSessionsForUser: jest.fn().mockResolvedValue([[], 0]),
            listRecentForOrganization: jest.fn().mockResolvedValue([]),
        };
        ingestedEventRepository = {
            findRecentByUser: jest.fn().mockResolvedValue([]),
            findRecentByOrganization: jest.fn().mockResolvedValue([]),
        };
        notificationService = { notifyDigest: jest.fn().mockResolvedValue(undefined) };
        goalsService = { listForUser: jest.fn().mockResolvedValue([]) };
        escalationService = { listOpenForUser: jest.fn().mockResolvedValue([]) };
        organizationRepository = {
            findById: jest.fn().mockResolvedValue({
                id: 'org-1',
                tenantId: 'tenant-1',
                displayName: 'Acme',
                digestSettings: { enabled: true, cadence: 'daily' },
            }),
            findWithDigestSettings: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue(undefined),
        };
        tenantRepository = {
            findById: jest.fn().mockResolvedValue({ id: 'tenant-1', ownerUserId: 'owner-1' }),
        };
        aiFacade = {
            isConfigured: jest.fn().mockReturnValue(true),
            createChatCompletion: jest.fn().mockResolvedValue({
                choices: [
                    { message: { content: 'A steady day: one run landed, one PR is open.' } },
                ],
            }),
        };
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

    // ── Org scope ────────────────────────────────────────────────────

    describe('composeOrgDigest', () => {
        const seedOrgActivity = () => {
            agentRunRepository.listRecentForOrganization.mockResolvedValue([
                {
                    id: 'run-org',
                    status: 'completed',
                    finishedAt: hoursAgo(2),
                    createdAt: hoursAgo(3),
                    summary: 'Shipped the pricing page',
                },
            ]);
            taskRepository.findRecentByOrganization.mockResolvedValue([
                {
                    id: 't-org',
                    title: 'Org task',
                    status: TaskStatus.DONE,
                    updatedAt: hoursAgo(4),
                },
            ]);
            ingestedEventRepository.findRecentByOrganization.mockResolvedValue([
                { source: 'github', occurredAt: hoursAgo(1) },
            ]);
        };

        it('⭐ reads ORG-keyed rows and never the per-user ones', async () => {
            // The whole point of the org scope: an org briefing must not
            // be one member's digest with a different title.
            seedOrgActivity();

            await build().composeOrgDigest('org-1', { period: 'daily', now: NOW });

            expect(agentRunRepository.listRecentForOrganization).toHaveBeenCalledWith(
                'org-1',
                expect.any(Number),
            );
            expect(taskRepository.findRecentByOrganization).toHaveBeenCalledWith(
                'org-1',
                expect.any(Number),
            );
            expect(ingestedEventRepository.findRecentByOrganization).toHaveBeenCalledWith(
                'org-1',
                expect.any(Number),
            );
            // Not one owner-scoped read anywhere in an org composition.
            expect(agentRunRepository.listSessionsForUser).not.toHaveBeenCalled();
            expect(taskRepository.findByUserIdFiltered).not.toHaveBeenCalled();
            expect(ingestedEventRepository.findRecentByUser).not.toHaveBeenCalled();
        });

        it('labels the digest with the organization and reports the org scope', async () => {
            seedOrgActivity();

            const digest = await build().composeOrgDigest('org-1', {
                period: 'daily',
                now: NOW,
            });

            expect(digest.scope).toBe('organization');
            expect(digest.subjectId).toBe('org-1');
            expect(digest.markdown).toContain('# Acme — daily digest');
            expect(digest.text).toContain('Organization daily digest');
        });

        it('counts org rows with the SAME window rules as the personal digest', async () => {
            agentRunRepository.listRecentForOrganization.mockResolvedValue([
                {
                    id: 'run-in',
                    status: 'completed',
                    finishedAt: hoursAgo(2),
                    createdAt: hoursAgo(3),
                    summary: 'In window',
                },
                {
                    id: 'run-out',
                    status: 'completed',
                    finishedAt: daysAgo(3),
                    createdAt: daysAgo(3),
                    summary: 'Out of window',
                },
            ]);

            const svc = build();
            const daily = await svc.composeOrgDigest('org-1', { period: 'daily', now: NOW });
            const weekly = await svc.composeOrgDigest('org-1', { period: 'weekly', now: NOW });

            expect(daily.counts.runsCompleted).toBe(1);
            expect(weekly.counts.runsCompleted).toBe(2);
        });

        it('omits the goals and escalations sections — both stores are user-scoped', async () => {
            // Filling them with the tenant owner's personal rows and
            // calling them "the organization's" would be a fabricated
            // number, which this feature refuses to print.
            seedOrgActivity();
            goalsService.listForUser.mockResolvedValue([
                { id: 'g1', title: 'Owner goal', currentValue: 1, targetValue: 2, unit: 'x' },
            ]);
            escalationService.listOpenForUser.mockResolvedValue([
                { id: 'e1', reasonCode: 'x', summary: 's', decisionNeeded: 'd' },
            ]);

            const digest = await build().composeOrgDigest('org-1', {
                period: 'daily',
                now: NOW,
            });

            expect(digest.counts.goalsTracked).toBe(0);
            expect(digest.counts.escalationsOpen).toBe(0);
            expect(digest.markdown).not.toContain('## Goal progress');
            expect(digest.markdown).not.toContain('## Needs your decision');
            expect(goalsService.listForUser).not.toHaveBeenCalled();
            expect(escalationService.listOpenForUser).not.toHaveBeenCalled();
        });

        it('falls back to a neutral heading when the org has no display name', async () => {
            seedOrgActivity();
            organizationRepository.findById.mockResolvedValue({
                id: 'org-1',
                tenantId: 'tenant-1',
                displayName: '   ',
            });

            const digest = await build().composeOrgDigest('org-1', {
                period: 'weekly',
                now: NOW,
            });

            expect(digest.markdown).toContain('# Your organization — weekly digest');
        });
    });

    describe('deliverOrgDigest', () => {
        const seedOrgActivity = () => {
            agentRunRepository.listRecentForOrganization.mockResolvedValue([
                {
                    id: 'run-org',
                    status: 'completed',
                    finishedAt: hoursAgo(2),
                    createdAt: hoursAgo(3),
                    summary: 'Did org things',
                },
            ]);
        };

        it('delivers to the tenant owner with an ORG-keyed dedup key', async () => {
            // Org-keyed so an org briefing can never dedupe away (or
            // collide with) the recipient's own personal digest row for
            // the same window.
            seedOrgActivity();

            const result = await build().deliverOrgDigest('org-1', 'daily', { now: NOW });

            expect(result.delivered).toBe(true);
            expect(result.recipients).toEqual(['owner-1']);
            expect(notificationService.notifyDigest).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'owner-1',
                    period: 'daily',
                    title: 'Acme — daily digest',
                    deduplicationKey: 'digest_org_org-1_daily_2026-07-25',
                }),
            );
        });

        it('skips organizations that never opted in', async () => {
            seedOrgActivity();
            organizationRepository.findById.mockResolvedValue({
                id: 'org-1',
                tenantId: 'tenant-1',
                displayName: 'Acme',
                digestSettings: null,
            });

            const result = await build().deliverOrgDigest('org-1', 'daily', { now: NOW });

            expect(result).toEqual({ delivered: false, reason: 'digest-off' });
            expect(notificationService.notifyDigest).not.toHaveBeenCalled();
        });

        it('skips a cadence mismatch (weekly org, daily pass) unless forced', async () => {
            seedOrgActivity();
            organizationRepository.findById.mockResolvedValue({
                id: 'org-1',
                tenantId: 'tenant-1',
                displayName: 'Acme',
                digestSettings: { enabled: true, cadence: 'weekly' },
            });
            const svc = build();

            expect(await svc.deliverOrgDigest('org-1', 'daily', { now: NOW })).toEqual({
                delivered: false,
                reason: 'period-mismatch',
            });

            const forced = await svc.deliverOrgDigest('org-1', 'daily', { now: NOW, force: true });
            expect(forced.delivered).toBe(true);
        });

        it('defaults an enabled org with no cadence to weekly', async () => {
            seedOrgActivity();
            organizationRepository.findById.mockResolvedValue({
                id: 'org-1',
                tenantId: 'tenant-1',
                displayName: 'Acme',
                digestSettings: { enabled: true },
            });
            const svc = build();

            expect((await svc.deliverOrgDigest('org-1', 'daily', { now: NOW })).delivered).toBe(
                false,
            );
            expect((await svc.deliverOrgDigest('org-1', 'weekly', { now: NOW })).delivered).toBe(
                true,
            );
        });

        it('skips quiet org windows instead of sending an empty briefing', async () => {
            const result = await build().deliverOrgDigest('org-1', 'daily', { now: NOW });

            expect(result.delivered).toBe(false);
            expect(result.reason).toBe('quiet-period');
            expect(notificationService.notifyDigest).not.toHaveBeenCalled();
        });

        it('reports no-recipient when the tenant owner cannot be resolved', async () => {
            seedOrgActivity();
            tenantRepository.findById.mockResolvedValue(null);

            const result = await build().deliverOrgDigest('org-1', 'daily', { now: NOW });

            expect(result).toEqual({ delivered: false, reason: 'no-recipient' });
            expect(notificationService.notifyDigest).not.toHaveBeenCalled();
        });

        it('⭐ never touches the per-user digest path', async () => {
            // Extension, not replacement: an org delivery must not read,
            // gate on, or consume a member's personal preference.
            seedOrgActivity();

            await build().deliverOrgDigest('org-1', 'daily', { now: NOW });

            expect(userRepository.findById).not.toHaveBeenCalled();
            expect(userRepository.findByDigestFrequency).not.toHaveBeenCalled();
        });
    });

    describe('dispatchDueOrganizations', () => {
        it('selects only opted-in orgs and tallies outcomes', async () => {
            organizationRepository.findWithDigestSettings.mockResolvedValue([
                {
                    id: 'org-active',
                    tenantId: 'tenant-1',
                    displayName: 'Active',
                    digestSettings: { enabled: true, cadence: 'daily' },
                },
                {
                    id: 'org-quiet',
                    tenantId: 'tenant-1',
                    displayName: 'Quiet',
                    digestSettings: { enabled: true, cadence: 'daily' },
                },
                {
                    id: 'org-off',
                    tenantId: 'tenant-1',
                    displayName: 'Off',
                    digestSettings: { enabled: false },
                },
            ]);
            organizationRepository.findById.mockImplementation(async (id: string) => ({
                id,
                tenantId: 'tenant-1',
                displayName: id,
                digestSettings:
                    id === 'org-off'
                        ? { enabled: false }
                        : { enabled: true, cadence: 'daily' as const },
            }));
            agentRunRepository.listRecentForOrganization.mockImplementation(
                async (organizationId: string) =>
                    organizationId === 'org-active'
                        ? [
                              {
                                  id: 'r1',
                                  status: 'completed',
                                  finishedAt: hoursAgo(1),
                                  createdAt: hoursAgo(2),
                                  summary: 'ok',
                              },
                          ]
                        : [],
            );

            const summary = await build().dispatchDueOrganizations('daily', { now: NOW });

            expect(summary).toEqual({
                period: 'daily',
                selected: 3,
                delivered: 1,
                skippedQuiet: 1,
                skipped: 1,
                failed: 0,
            });
        });

        it('stamps lastRunAt on the orgs it actually delivered to', async () => {
            organizationRepository.findWithDigestSettings.mockResolvedValue([
                {
                    id: 'org-1',
                    tenantId: 'tenant-1',
                    displayName: 'Acme',
                    digestSettings: { enabled: true, cadence: 'daily' },
                },
            ]);
            agentRunRepository.listRecentForOrganization.mockResolvedValue([
                {
                    id: 'r1',
                    status: 'completed',
                    finishedAt: hoursAgo(1),
                    createdAt: hoursAgo(2),
                    summary: 'ok',
                },
            ]);

            await build().dispatchDueOrganizations('daily', { now: NOW });

            expect(organizationRepository.update).toHaveBeenCalledWith('org-1', {
                digestSettings: expect.objectContaining({
                    enabled: true,
                    cadence: 'daily',
                    lastRunAt: NOW.toISOString(),
                }),
            });
        });

        it('counts a failing org and keeps sweeping the rest', async () => {
            organizationRepository.findWithDigestSettings.mockResolvedValue([
                { id: 'org-bad', tenantId: 't', digestSettings: { enabled: true } },
            ]);
            organizationRepository.findById.mockRejectedValue(new Error('db down'));

            const summary = await build().dispatchDueOrganizations('weekly', { now: NOW });

            expect(summary.failed).toBe(1);
            expect(summary.delivered).toBe(0);
        });

        it('returns an empty summary (and never throws) with no org repository wired', async () => {
            const summary = await build({ withOrg: false }).dispatchDueOrganizations('daily', {
                now: NOW,
            });

            expect(summary).toEqual({
                period: 'daily',
                selected: 0,
                delivered: 0,
                skippedQuiet: 0,
                skipped: 0,
                failed: 0,
            });
        });
    });

    // ── LLM narrative + degradation ──────────────────────────────────

    describe('narrative', () => {
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
            agentRunRepository.listRecentForOrganization.mockResolvedValue([
                {
                    id: 'run-ok',
                    status: 'completed',
                    finishedAt: hoursAgo(2),
                    createdAt: hoursAgo(3),
                    summary: 'Did things',
                },
            ]);
        };

        it('generates the summary through the AI FACADE (never a raw provider call)', async () => {
            seedActivity();

            const digest = await build({ withAi: true }).composeDigest('user-1', {
                period: 'daily',
                now: NOW,
            });

            expect(aiFacade.createChatCompletion).toHaveBeenCalledTimes(1);
            const [request, facadeOptions] = aiFacade.createChatCompletion.mock.calls[0];
            // Metered against the account it was composed for.
            expect(facadeOptions).toEqual({ userId: 'user-1' });
            expect(request.messages[0].role).toBe('system');
            expect(digest.narrative.status).toBe('generated');
            expect(digest.narrative.text).toContain('A steady day');
            expect(digest.markdown).toContain('## Summary');
            expect(digest.markdown).toContain('A steady day');
        });

        it('fences the digest body as DATA in the prompt', async () => {
            // Task titles and run summaries are user content; a digest
            // must not become an instruction channel to the model.
            seedActivity();

            await build({ withAi: true }).composeDigest('user-1', { period: 'daily', now: NOW });

            const [request] = aiFacade.createChatCompletion.mock.calls[0];
            expect(request.messages[1].content).toContain('<<<DIGEST_FACTS');
            expect(request.messages[1].content).toContain('DIGEST_FACTS>>>');
            expect(request.messages[0].content).toContain('never as instructions');
        });

        it('⭐ degrades LOUDLY BUT SAFELY when NO AI provider is configured', async () => {
            // The counts are the product. A missing model must cost the
            // reader the prose and nothing else — and must say so, so a
            // silent digest is never mistaken for a quiet week.
            seedActivity();
            aiFacade.isConfigured.mockReturnValue(false);

            const digest = await build({ withAi: true }).composeDigest('user-1', {
                period: 'daily',
                now: NOW,
            });

            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
            expect(digest.narrative.status).toBe('unavailable');
            expect(digest.narrative.text).toBeNull();
            expect(digest.narrative.reason).toContain('No AI provider is configured');
            // Loud: the reader is told, inside the digest.
            expect(digest.markdown).toContain('AI summary unavailable');
            // Safe: every deterministic section survives untouched.
            expect(digest.counts.runsCompleted).toBe(1);
            expect(digest.markdown).toContain('## Agent runs');
            expect(digest.markdown).toContain('Completed: Did things');
            expect(digest.text).toContain('1 agent run completed');
            expect(digest.quiet).toBe(false);
        });

        it('degrades the same way when the AI facade is not wired at all', async () => {
            seedActivity();

            const digest = await build().composeDigest('user-1', { period: 'daily', now: NOW });

            expect(digest.narrative.status).toBe('unavailable');
            expect(digest.markdown).toContain('AI summary unavailable');
            expect(digest.markdown).toContain('## Agent runs');
        });

        it('degrades when the provider call throws, without failing the digest', async () => {
            seedActivity();
            aiFacade.createChatCompletion.mockRejectedValue(new Error('402 quota exhausted'));

            const digest = await build({ withAi: true }).composeDigest('user-1', {
                period: 'daily',
                now: NOW,
            });

            expect(digest.narrative.status).toBe('failed');
            expect(digest.narrative.reason).toContain('402 quota exhausted');
            expect(digest.markdown).toContain('AI summary unavailable');
            expect(digest.counts.runsCompleted).toBe(1);
        });

        it('degrades when the provider returns an empty summary', async () => {
            seedActivity();
            aiFacade.createChatCompletion.mockResolvedValue({
                choices: [{ message: { content: '   ' } }],
            });

            const digest = await build({ withAi: true }).composeDigest('user-1', {
                period: 'daily',
                now: NOW,
            });

            expect(digest.narrative.status).toBe('failed');
            expect(digest.narrative.text).toBeNull();
            expect(digest.counts.runsCompleted).toBe(1);
        });

        it('skips the call entirely on an explicit opt-out', async () => {
            seedActivity();

            const digest = await build({ withAi: true }).composeDigest('user-1', {
                period: 'daily',
                now: NOW,
                narrative: false,
            });

            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
            expect(digest.narrative.status).toBe('disabled');
            // An opt-out is not a degradation — no banner.
            expect(digest.markdown).not.toContain('AI summary unavailable');
        });

        it('spends nothing on a quiet window', async () => {
            const digest = await build({ withAi: true }).composeDigest('user-1', {
                period: 'daily',
                now: NOW,
            });

            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
            expect(digest.narrative.status).toBe('disabled');
            expect(digest.quiet).toBe(true);
        });

        it('meters an org narrative against the resolved recipient', async () => {
            seedActivity();

            await build({ withAi: true }).deliverOrgDigest('org-1', 'daily', { now: NOW });

            expect(aiFacade.createChatCompletion).toHaveBeenCalledWith(expect.any(Object), {
                userId: 'owner-1',
            });
        });

        it('skips the org narrative when the org opted out of it', async () => {
            seedActivity();
            organizationRepository.findById.mockResolvedValue({
                id: 'org-1',
                tenantId: 'tenant-1',
                displayName: 'Acme',
                digestSettings: { enabled: true, cadence: 'daily', narrative: false },
            });

            const result = await build({ withAi: true }).deliverOrgDigest('org-1', 'daily', {
                now: NOW,
            });

            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
            expect(result.digest?.narrative.status).toBe('disabled');
        });

        it('skips (instead of making an unattributed call) with no metering identity', async () => {
            seedActivity();

            const digest = await build({ withAi: true }).composeOrgDigest('org-1', {
                period: 'daily',
                now: NOW,
            });

            expect(aiFacade.createChatCompletion).not.toHaveBeenCalled();
            expect(digest.narrative.status).toBe('unavailable');
        });
    });

    // ── Settings persistence ─────────────────────────────────────────

    describe('personal digest settings', () => {
        it('projects the stored tri-state column onto enabled + cadence', async () => {
            userRepository.findById.mockResolvedValue({ id: 'user-1', digestFrequency: 'weekly' });

            await expect(build().getUserDigestSettings('user-1')).resolves.toEqual({
                enabled: true,
                cadence: 'weekly',
            });
        });

        it("reports 'off' as disabled, surfacing the default cadence for the form", async () => {
            userRepository.findById.mockResolvedValue({ id: 'user-1', digestFrequency: 'off' });

            await expect(build().getUserDigestSettings('user-1')).resolves.toEqual({
                enabled: false,
                cadence: 'daily',
            });
        });

        it('treats a user with no stored preference as disabled rather than throwing', async () => {
            userRepository.findById.mockResolvedValue(null);

            await expect(build().getUserDigestSettings('ghost')).resolves.toEqual({
                enabled: false,
                cadence: 'daily',
            });
        });

        it('persists an enable + cadence change onto users.digestFrequency', async () => {
            userRepository.findById.mockResolvedValue({ id: 'user-1', digestFrequency: 'off' });

            const settings = await build().updateUserDigestSettings('user-1', {
                enabled: true,
                cadence: 'weekly',
            });

            expect(userRepository.update).toHaveBeenCalledWith('user-1', {
                digestFrequency: 'weekly',
            });
            expect(settings).toEqual({ enabled: true, cadence: 'weekly' });
        });

        it("collapses a disable to 'off' without losing the cadence the form shows", async () => {
            userRepository.findById.mockResolvedValue({ id: 'user-1', digestFrequency: 'weekly' });

            const settings = await build().updateUserDigestSettings('user-1', { enabled: false });

            expect(userRepository.update).toHaveBeenCalledWith('user-1', {
                digestFrequency: 'off',
            });
            expect(settings).toEqual({ enabled: false, cadence: 'weekly' });
        });

        it('applies a cadence-only save against the currently enabled state', async () => {
            userRepository.findById.mockResolvedValue({ id: 'user-1', digestFrequency: 'daily' });

            const settings = await build().updateUserDigestSettings('user-1', {
                cadence: 'weekly',
            });

            expect(userRepository.update).toHaveBeenCalledWith('user-1', {
                digestFrequency: 'weekly',
            });
            expect(settings).toEqual({ enabled: true, cadence: 'weekly' });
        });

        it('rejects a write against a user that does not exist', async () => {
            userRepository.findById.mockResolvedValue(null);

            await expect(
                build().updateUserDigestSettings('ghost', { enabled: true }),
            ).rejects.toThrow(/not found/i);
            expect(userRepository.update).not.toHaveBeenCalled();
        });

        it('⭐ writes ONLY digestFrequency — no other profile field is touched', async () => {
            await build().updateUserDigestSettings('user-1', { enabled: true, cadence: 'daily' });

            expect(userRepository.update).toHaveBeenCalledTimes(1);
            expect(Object.keys(userRepository.update.mock.calls[0][1])).toEqual([
                'digestFrequency',
            ]);
        });

        it('⭐ saving a PERSONAL preference never touches the org settings', async () => {
            await build().updateUserDigestSettings('user-1', { enabled: true, cadence: 'daily' });

            expect(organizationRepository.update).not.toHaveBeenCalled();
            expect(organizationRepository.findById).not.toHaveBeenCalled();
        });
    });

    describe('org digest settings', () => {
        it('reads back the effective defaults for an org that never configured one', async () => {
            organizationRepository.findById.mockResolvedValue({
                id: 'org-1',
                tenantId: 'tenant-1',
                displayName: 'Acme',
                digestSettings: null,
            });

            const settings = await build().getOrgDigestSettings('org-1');

            expect(settings).toEqual({
                enabled: false,
                cadence: 'weekly',
                narrative: true,
                lastRunAt: null,
            });
        });

        it('persists an enable + cadence change and returns the effective values', async () => {
            organizationRepository.findById.mockResolvedValue({
                id: 'org-1',
                tenantId: 'tenant-1',
                displayName: 'Acme',
                digestSettings: null,
            });

            const settings = await build().updateOrgDigestSettings('org-1', {
                enabled: true,
                cadence: 'daily',
            });

            expect(organizationRepository.update).toHaveBeenCalledWith('org-1', {
                digestSettings: { enabled: true, cadence: 'daily' },
            });
            expect(settings).toEqual({
                enabled: true,
                cadence: 'daily',
                narrative: true,
                lastRunAt: null,
            });
        });

        it('⭐ merges over stored settings so a partial save never wipes lastRunAt', async () => {
            organizationRepository.findById.mockResolvedValue({
                id: 'org-1',
                tenantId: 'tenant-1',
                displayName: 'Acme',
                digestSettings: {
                    enabled: true,
                    cadence: 'daily',
                    narrative: false,
                    lastRunAt: '2026-07-20T00:00:00.000Z',
                },
            });

            const settings = await build().updateOrgDigestSettings('org-1', { cadence: 'weekly' });

            expect(organizationRepository.update).toHaveBeenCalledWith('org-1', {
                digestSettings: {
                    enabled: true,
                    cadence: 'weekly',
                    narrative: false,
                    lastRunAt: '2026-07-20T00:00:00.000Z',
                },
            });
            expect(settings.narrative).toBe(false);
            expect(settings.lastRunAt).toBe('2026-07-20T00:00:00.000Z');
        });

        it('rejects a write against an organization that does not exist', async () => {
            organizationRepository.findById.mockResolvedValue(null);

            await expect(
                build().updateOrgDigestSettings('ghost', { enabled: true }),
            ).rejects.toThrow(/not found/i);
            expect(organizationRepository.update).not.toHaveBeenCalled();
        });

        it('⭐ turning an ORG digest on does not change any per-user preference', async () => {
            // Additive by construction: `users.digestFrequency` is a
            // different column with a different writer.
            await build().updateOrgDigestSettings('org-1', { enabled: true, cadence: 'daily' });

            expect(organizationRepository.update).toHaveBeenCalledTimes(1);
            expect(userRepository.findById).not.toHaveBeenCalled();
        });
    });
});

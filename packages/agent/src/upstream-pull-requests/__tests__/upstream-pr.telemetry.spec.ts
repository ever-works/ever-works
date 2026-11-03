import { UpstreamPullRequestOpenService } from '../upstream-pull-request-open.service';
import { UpstreamPullRequestRecordService } from '../upstream-pull-request-record.service';
import {
    UPSTREAM_PR_TELEMETRY_EVENTS,
    UpstreamPrTelemetry,
    upstreamPrRefusedPhase,
} from '../upstream-pr.telemetry';
import type { UpstreamRateLimitRefusal } from '../upstream-rate-limits';

/**
 * APW-09 (Gauzy Ever Works #37, 2026-10-29) — plan §9.1's upstream pull request telemetry:
 * counters and ids only, never titles, bodies, diffs, logins or repository names.
 *
 * Each case asserts the event fires at its moment with its payload, that the title, the
 * body, the branch, the logins, the repositories and the url never reach the sink, and that
 * a sink which throws never changes what `open` answers.
 */
describe('Upstream pull request telemetry (APW-09)', () => {
    type Sent = { distinctId: string; event: string; properties: Record<string, unknown> };

    function sink(): { sent: Sent[]; track: (...args: unknown[]) => void } {
        const sent: Sent[] = [];
        return {
            sent,
            track: (distinctId: unknown, event: unknown, properties: unknown) =>
                sent.push({
                    distinctId: String(distinctId),
                    event: String(event),
                    properties: properties as Record<string, unknown>,
                }),
        };
    }

    const throwingSink = {
        track: () => {
            throw new Error('analytics down');
        },
    };

    const FORBIDDEN = [
        'example-org',
        'helpdesk',
        'Fix the login page',
        'feature/login',
        'tok-1234',
        'https://',
        'provider exploded',
    ];

    function expectClean(sent: readonly Sent[]): void {
        const text = JSON.stringify(sent.map((entry) => entry.properties));
        for (const value of FORBIDDEN) {
            expect(text).not.toContain(value);
        }
    }

    type Row = Record<string, any>;

    function fakeRepository() {
        const rows: Row[] = [];
        let next = 0;
        return {
            rows,
            findForWork: jest.fn(
                async (workId: string, id: string) =>
                    rows.find((r) => r.id === id && r.workId === workId) ?? null,
            ),
            findActiveBySourceTask: jest.fn(async () => null),
            insertActive: jest.fn(async (input: Row) => {
                next += 1;
                const row = {
                    id: `r${next}`,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    ...input,
                };
                rows.push(row);
                return { inserted: true, row, activeId: null };
            }),
            updateStateIf: jest.fn(
                async (id: string, workId: string, from: string[], to: string, patch: Row = {}) => {
                    const row = rows.find((r) => r.id === id && r.workId === workId);
                    if (!row || !from.includes(row.state)) return false;
                    Object.assign(row, patch, { state: to });
                    return true;
                },
            ),
            patchIf: jest.fn(async () => true),
        };
    }

    function work() {
        return {
            id: 'w1',
            userId: 'owner',
            kind: 'app',
            sourceRepository: {
                type: 'app_fork',
                owner: 'me',
                repo: 'helpdesk',
                upstream: { owner: 'example-org', repo: 'helpdesk', defaultBranch: 'main' },
            },
            getRepoOwner: () => 'me',
            getDataRepo: () => 'helpdesk-data',
            getWebsiteRepo: () => 'helpdesk',
        };
    }

    function build(
        target: { track: (...args: unknown[]) => void },
        opts: { limit?: UpstreamRateLimitRefusal | null; providerFails?: boolean } = {},
    ) {
        const repository = fakeRepository();
        const records = new UpstreamPullRequestRecordService(
            repository as never,
            { log: jest.fn(async () => ({})) } as never,
        );
        const git = {
            createPullRequest: jest.fn(async () => {
                if (opts.providerFails)
                    throw new Error('provider exploded on example-org/helpdesk');
                return { number: 7, url: 'https://github.com/example-org/helpdesk/pull/7' };
            }),
        };
        const service = new UpstreamPullRequestOpenService(
            { findById: jest.fn(async () => work()) } as never,
            {
                findById: jest.fn(async () => ({
                    id: 't1',
                    workId: 'w1',
                    userId: 'owner',
                    branchRef: 'feature/login',
                    title: 'Fix the login page',
                })),
            } as never,
            {
                resolveForPublishingMember: jest.fn(async () => ({
                    usable: true,
                    credential: { userId: 'editor', providerId: 'github', token: 'tok-1234' },
                })),
            } as never,
            git as never,
            undefined,
            records,
            { limitsFor: jest.fn(async () => opts.limit ?? null) } as never,
            new UpstreamPrTelemetry(target),
        );
        return { service, git, repository };
    }

    it('maps a refusal code to its phase', () => {
        expect(upstreamPrRefusedPhase('providerRefused')).toBe('open');
        expect(upstreamPrRefusedPhase('rateLimited')).toBe('eligibility');
        expect(upstreamPrRefusedPhase('connectionScope')).toBe('eligibility');
    });

    it('counts and drops when unbound, never throws on a throwing sink', () => {
        const unbound = new UpstreamPrTelemetry(undefined);
        unbound.track(UPSTREAM_PR_TELEMETRY_EVENTS.final, { outcome: 'merged', daysOpen: 2 });
        expect(unbound.stats()).toMatchObject({ emitted: 0, dropped: 1 });
        const throwing = new UpstreamPrTelemetry(throwingSink);
        expect(() =>
            throwing.track(UPSTREAM_PR_TELEMETRY_EVENTS.final, { outcome: 'closed', daysOpen: 1 }),
        ).not.toThrow();
        expect(throwing.stats().failed).toBe(1);
    });

    it('emits proposed when the record is claimed, then opened — ids and flags only', async () => {
        const target = sink();
        const { service } = build(target);

        const result = await service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });

        expect(result).toMatchObject({ status: 'opened', number: 7 });
        expect(target.sent).toEqual([
            {
                distinctId: 'editor',
                event: 'upstream_pr.proposed',
                properties: { workId: 'w1', taskId: 't1' },
            },
            {
                distinctId: 'editor',
                event: 'upstream_pr.opened',
                properties: { minutesApprovalToOpen: null, draft: true, fromTask: true },
            },
        ]);
        expectClean(target.sent);
    });

    it('emits only refused (phase eligibility) for a limit refusal, with no proposal', async () => {
        const target = sink();
        const { service, repository } = build(target, {
            limit: {
                code: 'rateLimited',
                limit: 'openedPerUpstreamPer24h',
                limitValue: 1,
                nextSlotAt: '2026-10-28T10:00:00.000Z',
            },
        });

        const result = await service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });

        expect(result).toMatchObject({ status: 'refused', code: 'rateLimited' });
        expect(repository.rows).toHaveLength(0);
        expect(target.sent).toEqual([
            {
                distinctId: 'editor',
                event: 'upstream_pr.refused',
                properties: { code: 'rateLimited', phase: 'eligibility' },
            },
        ]);
    });

    it('emits proposed then refused (phase open) when the provider refuses, never its message', async () => {
        const target = sink();
        const { service } = build(target, { providerFails: true });

        const result = await service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });

        expect(result).toMatchObject({ status: 'refused', code: 'providerRefused' });
        expect(target.sent.map((entry) => [entry.event, entry.properties])).toEqual([
            ['upstream_pr.proposed', { workId: 'w1', taskId: 't1' }],
            ['upstream_pr.refused', { code: 'providerRefused', phase: 'open' }],
        ]);
        expectClean(target.sent);
    });

    it('a throwing sink never changes what open answers', async () => {
        const { service, git } = build(throwingSink);
        await expect(
            service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' }),
        ).resolves.toMatchObject({ status: 'opened', number: 7 });
        expect(git.createPullRequest).toHaveBeenCalledTimes(1);
    });
});

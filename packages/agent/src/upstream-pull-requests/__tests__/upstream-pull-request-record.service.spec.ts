import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';
import {
    UPSTREAM_DIRECT_OPENING_STALE_MS,
    UpstreamPullRequestRecordService,
    toUpstreamPullRequestView,
} from '../upstream-pull-request-record.service';
import {
    UpstreamPullRequestOpenService,
    redactProviderMessage,
} from '../upstream-pull-request-open.service';

/**
 * APW-09 T7/T35 — the record's one writer, and `POST /api/works/:id/upstream-pr` writing it.
 *
 * Each gate has a case that fails without it:
 *  - the active-slot claim happens BEFORE the provider call, so a second request for the same
 *    Task is `409 activeProposal` and reaches no provider (FR-5);
 *  - a successful open moves `opening → open` with the number and URL, and writes ONE
 *    `app_upstream_pr` Activity row whose details carry no title, body or token (FR-37);
 *  - a provider refusal moves `opening → failed`, clears `openedAt` (so the 24-hour window does
 *    not count it) and keeps the provider message without the token;
 *  - the view never carries the fingerprint or the scope columns.
 */

type Row = Record<string, any>;

function fakeRepository(initial: Row[] = []) {
    const rows: Row[] = [...initial];
    let next = 0;
    return {
        rows,
        findActiveBySourceTask: jest.fn(async (workId: string, sourceTaskId: string) => {
            return (
                rows.find(
                    (row) =>
                        row.workId === workId &&
                        row.sourceTaskId === sourceTaskId &&
                        [
                            'preparing',
                            'needs_signature',
                            'awaiting_approval',
                            'opening',
                            'open',
                        ].includes(row.state),
                ) ?? null
            );
        }),
        insertActive: jest.fn(async (input: Row) => {
            const clash = rows.find(
                (row) =>
                    input.sourceTaskId &&
                    row.sourceTaskId === input.sourceTaskId &&
                    [
                        'preparing',
                        'needs_signature',
                        'awaiting_approval',
                        'opening',
                        'open',
                    ].includes(row.state),
            );
            if (clash) return { inserted: false, activeId: clash.id };
            next += 1;
            const row = {
                id: `r${next}`,
                origin: 'proposal',
                draft: false,
                maintainerCanModify: true,
                createdAt: new Date(),
                updatedAt: new Date(),
                ...input,
            };
            rows.push(row);
            return { inserted: true, row };
        }),
        updateStateIf: jest.fn(
            async (id: string, workId: string, from: string[], to: string, patch: Row = {}) => {
                const row = rows.find((r) => r.id === id && r.workId === workId);
                if (!row || !from.includes(row.state)) return false;
                Object.assign(row, patch, { state: to });
                return true;
            },
        ),
    };
}

function work() {
    return {
        id: 'w1',
        userId: 'owner',
        kind: 'app',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
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

function build(options: { repository?: ReturnType<typeof fakeRepository>; fail?: Error } = {}) {
    const repository = options.repository ?? fakeRepository();
    const activity = { log: jest.fn(async () => ({})) };
    const records = new UpstreamPullRequestRecordService(repository as never, activity as never);
    const works = { findById: jest.fn(async () => work()) };
    const tasks = {
        findById: jest.fn(async (id: string) =>
            id === 't1'
                ? {
                      id: 't1',
                      workId: 'w1',
                      userId: 'owner',
                      branchRef: 'ever-works/t-1',
                      title: 'Change: Add dark mode',
                  }
                : null,
        ),
    };
    const credentials = {
        resolveForPublishingMember: jest.fn(async () => ({
            usable: true,
            workId: 'w1',
            memberUserId: 'editor',
            credential: { userId: 'editor', providerId: 'github', token: 'ghp_secret_token_value' },
        })),
    };
    const git = {
        createPullRequest: jest.fn(async () => {
            if (options.fail) throw options.fail;
            return { number: 7, url: 'https://github.com/example-org/helpdesk/pull/7' };
        }),
    };
    const service = new UpstreamPullRequestOpenService(
        works as never,
        tasks as never,
        credentials as never,
        git as never,
        undefined,
        records,
    );
    return { service, git, repository, activity, records };
}

describe('POST /api/works/:id/upstream-pr writes the record (APW-09 T7/T35)', () => {
    it('claims the slot before the provider call, then records the opened pull request', async () => {
        const { service, git, repository, activity } = build();
        git.createPullRequest.mockImplementationOnce(async () => {
            // The claim exists while the provider is being called.
            expect(repository.rows).toHaveLength(1);
            expect(repository.rows[0].state).toBe('opening');
            return { number: 7, url: 'https://github.com/example-org/helpdesk/pull/7' };
        });

        const result = await service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });

        expect(result).toMatchObject({
            status: 'opened',
            httpStatus: 201,
            number: 7,
            recordId: 'r1',
        });
        expect(repository.rows[0]).toMatchObject({
            state: 'open',
            origin: 'direct',
            userId: 'editor',
            workId: 'w1',
            sourceTaskId: 't1',
            upstreamOwner: 'example-org',
            upstreamRepo: 'helpdesk',
            baseBranch: 'main',
            headOwner: 'me',
            headBranch: 'ever-works/t-1',
            number: 7,
            url: 'https://github.com/example-org/helpdesk/pull/7',
            draft: true,
            tenantId: 'tenant-1',
            organizationId: 'org-1',
        });
        expect(repository.rows[0].nextCheckAt).toBeInstanceOf(Date);
        expect(JSON.stringify(repository.rows[0])).not.toContain('ghp_secret_token_value');

        expect(activity.log).toHaveBeenCalledTimes(1);
        const entry = (activity.log.mock.calls[0] as unknown[])[0] as Row;
        expect(entry).toMatchObject({
            userId: 'editor',
            workId: 'w1',
            actionType: ActivityActionType.APP_UPSTREAM_PR,
            action: 'app.upstream_pr.opened',
            status: ActivityStatus.COMPLETED,
            details: expect.objectContaining({
                upstream: 'example-org/helpdesk',
                number: 7,
                state: 'open',
                origin: 'direct',
            }),
        });
        // FR-37: never the title, the body or a token.
        const serialized = JSON.stringify(entry);
        expect(serialized).not.toContain('Add dark mode');
        expect(serialized).not.toContain('offered back upstream');
        expect(serialized).not.toContain('ghp_secret_token_value');
    });

    it('refuses a second request for a Task that already has an active record — no provider call', async () => {
        const { service, git } = build();
        await service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });
        git.createPullRequest.mockClear();

        const second = await service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });

        expect(second).toMatchObject({
            status: 'refused',
            httpStatus: 409,
            code: 'activeProposal',
            id: 'r1',
        });
        expect(git.createPullRequest).not.toHaveBeenCalled();
    });

    it('records a provider refusal as failed, clears openedAt, and keeps no token', async () => {
        const repository = fakeRepository();
        const { service, activity } = build({
            repository,
            fail: new Error('Validation Failed: head ghp_secret_token_value invalid'),
        });

        const result = await service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });

        expect(result).toMatchObject({
            status: 'refused',
            httpStatus: 502,
            code: 'providerRefused',
        });
        expect(repository.rows[0]).toMatchObject({
            state: 'failed',
            openedAt: null,
            nextCheckAt: null,
        });
        expect(repository.rows[0].refusalDetail).toContain('[redacted]');
        expect(repository.rows[0].refusalDetail).not.toContain('ghp_secret_token_value');
        expect((activity.log.mock.calls[0] as unknown[])[0]).toMatchObject({
            action: 'app.upstream_pr.failed',
            status: ActivityStatus.FAILED,
        });
        // The failed record frees the slot: the next attempt reaches the provider again.
        const again = build({ repository });
        await again.service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });
        expect(again.git.createPullRequest).toHaveBeenCalledTimes(1);
    });

    it('releases a direct record stuck in opening past the stale bound', async () => {
        const old = new Date(Date.now() - UPSTREAM_DIRECT_OPENING_STALE_MS - 60_000);
        const repository = fakeRepository([
            {
                id: 'stuck',
                workId: 'w1',
                sourceTaskId: 't1',
                state: 'opening',
                origin: 'direct',
                createdAt: old,
                updatedAt: old,
            },
        ]);
        const { service, git } = build({ repository });

        const result = await service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });

        expect(result).toMatchObject({ status: 'opened' });
        expect(repository.rows.find((row) => row.id === 'stuck')?.state).toBe('failed');
        expect(git.createPullRequest).toHaveBeenCalledTimes(1);
    });

    it('a branch-named request records a row with no source Task and never collides', async () => {
        const { service, repository } = build();
        await service.open({ workId: 'w1', callerUserId: 'editor', branch: 'feature/a' });
        await service.open({ workId: 'w1', callerUserId: 'editor', branch: 'feature/b' });
        expect(repository.rows.map((row) => [row.sourceTaskId, row.state])).toEqual([
            [null, 'open'],
            [null, 'open'],
        ]);
    });

    it('keeps the pre-record behaviour when no store is bound', async () => {
        const records = new UpstreamPullRequestRecordService(undefined, undefined);
        expect(records.available).toBe(false);
        await expect(
            records.claimDirect({
                workId: 'w1',
                userId: 'u',
                sourceTaskId: 't1',
                upstreamOwner: 'a',
                upstreamRepo: 'b',
                baseBranch: 'main',
                headOwner: 'c',
                headRepo: 'b',
                headBranch: 'x',
                title: null,
                body: null,
                draft: true,
                maintainerCanModify: true,
            }),
        ).resolves.toEqual({ status: 'unrecorded' });
    });
});

describe('toUpstreamPullRequestView', () => {
    it('maps every view field and leaks neither the fingerprint nor the scope columns', () => {
        const view = toUpstreamPullRequestView({
            id: 'r1',
            userId: 'u1',
            workId: 'w1',
            sourceTaskId: 't1',
            origin: 'direct',
            state: 'open',
            upstreamOwner: 'acme',
            upstreamRepo: 'bookings',
            baseBranch: 'main',
            headOwner: 'maya',
            headRepo: 'bookings',
            headBranch: 'x',
            headSha: null,
            number: 3,
            url: 'https://github.com/acme/bookings/pull/3',
            draft: true,
            maintainerCanModify: true,
            fingerprint: 'f'.repeat(64),
            tenantId: 'tenant-1',
            organizationId: 'org-1',
            preparationPausedMs: 0,
            openedAt: new Date('2026-10-27T10:00:00Z'),
            createdAt: new Date('2026-10-27T09:59:00Z'),
            updatedAt: new Date('2026-10-27T10:00:00Z'),
        } as never);
        expect(view).toMatchObject({
            id: 'r1',
            userId: 'u1',
            origin: 'direct',
            upstream: { owner: 'acme', repo: 'bookings', baseBranch: 'main' },
            head: { owner: 'maya', repo: 'bookings', branch: 'x', sha: null },
            number: 3,
            draft: true,
            openedAt: '2026-10-27T10:00:00.000Z',
            mergedAt: null,
        });
        const serialized = JSON.stringify(view);
        expect(serialized).not.toContain('f'.repeat(64));
        expect(Object.keys(view)).not.toEqual(expect.arrayContaining(['fingerprint']));
        expect(Object.keys(view)).not.toContain('tenantId');
        expect(Object.keys(view)).not.toContain('organizationId');
    });
});

describe('redactProviderMessage', () => {
    it('removes the token and caps the text', () => {
        expect(redactProviderMessage('bad tok12345 here', 'tok12345')).toBe('bad [redacted] here');
        expect(redactProviderMessage('x'.repeat(900), null)).toHaveLength(500);
    });
});

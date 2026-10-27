import { ActivityStatus } from '../../entities/activity-log.types';
import { UpstreamPullRequestOpenService } from '../upstream-pull-request-open.service';
import { UpstreamPullRequestRecordService } from '../upstream-pull-request-record.service';
import type { UpstreamRateLimitRefusal } from '../upstream-rate-limits';

/**
 * APW-09 T8 — the FR-26 / FR-39 limits are enforced SERVER-SIDE on the one door that opens a
 * pull request today (`POST /api/works/:id/upstream-pr`), and T19's member state changes
 * (withdraw, acknowledge extra files) are gated by author and state.
 *
 * Each gate has a case that fails without it:
 *  - a full window refuses `429` with `limit` and `nextSlotAt` BEFORE the credential or the
 *    provider is touched, and writes no record;
 *  - the post-claim re-check refuses a request that a concurrent one pushed over the limit, and
 *    moves its own claim to `refused` (so the window does not count it);
 *  - withdraw: author or Work owner only, pre-open states only;
 *  - acknowledge: author only, only while awaiting approval, only when there are extra files.
 */

type Row = Record<string, any>;

function fakeRepository(initial: Row[] = []) {
    const rows: Row[] = [...initial];
    let next = 0;
    const active = ['preparing', 'needs_signature', 'awaiting_approval', 'opening', 'open'];
    return {
        rows,
        findForWork: jest.fn(
            async (workId: string, id: string) =>
                rows.find((r) => r.id === id && r.workId === workId) ?? null,
        ),
        findActiveBySourceTask: jest.fn(
            async (workId: string, sourceTaskId: string) =>
                rows.find(
                    (r) =>
                        r.workId === workId &&
                        r.sourceTaskId === sourceTaskId &&
                        active.includes(r.state),
                ) ?? null,
        ),
        insertActive: jest.fn(async (input: Row) => {
            next += 1;
            const row = { id: `r${next}`, createdAt: new Date(), updatedAt: new Date(), ...input };
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
        patchIf: jest.fn(async (id: string, workId: string, from: string[], patch: Row) => {
            const row = rows.find((r) => r.id === id && r.workId === workId);
            if (!row || !from.includes(row.state)) return false;
            Object.assign(row, patch);
            return true;
        }),
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

function build(limits: Array<UpstreamRateLimitRefusal | null | Error>) {
    const repository = fakeRepository();
    const activity = { log: jest.fn(async () => ({})) };
    const records = new UpstreamPullRequestRecordService(repository as never, activity as never);
    const eligibility = {
        limitsFor: jest.fn(async () => {
            const next = limits.shift() ?? null;
            if (next instanceof Error) throw next;
            return next;
        }),
    };
    const credentials = {
        resolveForPublishingMember: jest.fn(async () => ({
            usable: true,
            credential: { userId: 'editor', providerId: 'github', token: 'tok-1234' },
        })),
    };
    const git = {
        createPullRequest: jest.fn(async () => ({
            number: 7,
            url: 'https://github.com/example-org/helpdesk/pull/7',
        })),
    };
    const service = new UpstreamPullRequestOpenService(
        { findById: jest.fn(async () => work()) } as never,
        {
            findById: jest.fn(async () => ({
                id: 't1',
                workId: 'w1',
                userId: 'owner',
                branchRef: 'b1',
                title: 'x',
            })),
        } as never,
        credentials as never,
        git as never,
        undefined,
        records,
        eligibility as never,
    );
    return { service, git, credentials, repository, eligibility, activity };
}

describe('the direct route enforces FR-26 / FR-39 (APW-09 T8)', () => {
    it('refuses 429 with the limit and the next slot before any credential or provider call', async () => {
        const { service, git, credentials, repository } = build([
            {
                code: 'rateLimited',
                limit: 'openedPerUpstreamPer24h',
                limitValue: 1,
                nextSlotAt: '2026-10-28T10:00:00.000Z',
            },
        ]);
        const result = await service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });
        expect(result).toMatchObject({
            status: 'refused',
            httpStatus: 429,
            code: 'rateLimited',
            limit: 'openedPerUpstreamPer24h',
            nextSlotAt: '2026-10-28T10:00:00.000Z',
        });
        expect(credentials.resolveForPublishingMember).not.toHaveBeenCalled();
        expect(git.createPullRequest).not.toHaveBeenCalled();
        expect(repository.rows).toHaveLength(0);
    });

    it('answers platformCapReached for the FR-39 ceiling, and openPerUpstream without a next slot', async () => {
        const platform = build([
            {
                code: 'platformCapReached',
                limit: 'platformOpenedPerUpstreamPer24h',
                limitValue: 5,
                nextSlotAt: '2026-10-28T10:00:00.000Z',
            },
        ]);
        await expect(
            platform.service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' }),
        ).resolves.toMatchObject({
            httpStatus: 429,
            code: 'platformCapReached',
            limit: 'platformOpenedPerUpstreamPer24h',
        });

        const open = build([{ code: 'rateLimited', limit: 'openPerUpstream', limitValue: 3 }]);
        const result = await open.service.open({
            workId: 'w1',
            callerUserId: 'editor',
            taskId: 't1',
        });
        expect(result).toMatchObject({ httpStatus: 429, limit: 'openPerUpstream' });
        expect(result).not.toHaveProperty('nextSlotAt');
    });

    it('refuses a request a concurrent one pushed over the limit, and releases its own claim', async () => {
        const { service, git, repository, eligibility, activity } = build([
            null,
            {
                code: 'rateLimited',
                limit: 'openedPerUpstreamPer24h',
                limitValue: 1,
                nextSlotAt: '2026-10-28T10:00:00.000Z',
            },
        ]);
        const result = await service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' });
        expect(result).toMatchObject({ httpStatus: 429, code: 'rateLimited' });
        expect(git.createPullRequest).not.toHaveBeenCalled();
        expect(eligibility.limitsFor).toHaveBeenLastCalledWith(
            expect.objectContaining({ includesSelf: true }),
        );
        expect(repository.rows[0]).toMatchObject({
            state: 'refused',
            openedAt: null,
            refusalCode: 'rateLimited',
        });
        expect((activity.log.mock.calls[0] as unknown[])[0]).toMatchObject({
            action: 'app.upstream_pr.refused',
            status: ActivityStatus.FAILED,
        });
    });

    it('releases its own claim when the second look throws, and calls no provider', async () => {
        const { service, git, repository } = build([null, new Error('database went away')]);
        await expect(
            service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' }),
        ).rejects.toThrow('database went away');
        expect(git.createPullRequest).not.toHaveBeenCalled();
        expect(repository.rows[0]).toMatchObject({ state: 'failed', openedAt: null });
    });

    it('opens when both looks pass', async () => {
        const { service, git, repository } = build([null, null]);
        await expect(
            service.open({ workId: 'w1', callerUserId: 'editor', taskId: 't1' }),
        ).resolves.toMatchObject({ status: 'opened' });
        expect(git.createPullRequest).toHaveBeenCalledTimes(1);
        expect(repository.rows[0].state).toBe('open');
    });
});

describe('member state changes on a record (APW-09 T19, no credential)', () => {
    function recordWith(row: Row) {
        const repository = fakeRepository([
            {
                id: 'r1',
                workId: 'w1',
                userId: 'author',
                upstreamOwner: 'acme',
                upstreamRepo: 'bookings',
                origin: 'proposal',
                ...row,
            },
        ]);
        const activity = { log: jest.fn(async () => ({})) };
        return {
            repository,
            activity,
            records: new UpstreamPullRequestRecordService(repository as never, activity as never),
        };
    }

    it('lets the author withdraw before opening, writes the withdrawn Activity, and uses no credential', async () => {
        const { records, repository, activity } = recordWith({ state: 'awaiting_approval' });
        const result = await records.withdraw('w1', 'r1', { userId: 'author', isWorkOwner: false });
        expect(result).toMatchObject({ status: 'ok' });
        expect(repository.rows[0].state).toBe('withdrawn');
        expect(repository.rows[0].nextCheckAt).toBeNull();
        expect((activity.log.mock.calls[0] as unknown[])[0]).toMatchObject({
            action: 'app.upstream_pr.withdrawn',
            status: ActivityStatus.CANCELLED,
            userId: 'author',
        });
    });

    it('lets the Work owner withdraw, and refuses any other editor', async () => {
        const owner = recordWith({ state: 'preparing' });
        await expect(
            owner.records.withdraw('w1', 'r1', { userId: 'owner', isWorkOwner: true }),
        ).resolves.toMatchObject({
            status: 'ok',
        });
        const other = recordWith({ state: 'preparing' });
        await expect(
            other.records.withdraw('w1', 'r1', { userId: 'editor', isWorkOwner: false }),
        ).resolves.toMatchObject({
            status: 'refused',
            httpStatus: 403,
            code: 'authorRequired',
        });
        expect(other.repository.rows[0].state).toBe('preparing');
    });

    it.each(['opening', 'open', 'merged', 'withdrawn'])(
        'refuses to withdraw a %s record (409)',
        async (state) => {
            const { records, repository } = recordWith({ state });
            await expect(
                records.withdraw('w1', 'r1', { userId: 'author', isWorkOwner: false }),
            ).resolves.toMatchObject({
                status: 'refused',
                httpStatus: 409,
                code: 'notWithdrawable',
            });
            expect(repository.rows[0].state).toBe(state);
        },
    );

    it('answers 404 for another App Work’s record id', async () => {
        const { records } = recordWith({ state: 'preparing' });
        await expect(
            records.withdraw('w2', 'r1', { userId: 'author', isWorkOwner: true }),
        ).resolves.toMatchObject({
            httpStatus: 404,
        });
        await expect(records.acknowledgeExtraFiles('w2', 'r1', 'author')).resolves.toMatchObject({
            httpStatus: 404,
        });
    });

    it('records the extra-files acknowledgement for the author while awaiting approval', async () => {
        const { records, repository } = recordWith({
            state: 'awaiting_approval',
            diffStats: { files: 3, additions: 10, deletions: 1, extraFiles: ['CHANGELOG.md'] },
        });
        const now = new Date('2026-10-27T12:00:00.000Z');
        await expect(
            records.acknowledgeExtraFiles('w1', 'r1', 'author', now),
        ).resolves.toMatchObject({ status: 'ok' });
        expect(repository.rows[0]).toMatchObject({
            extraFilesAcknowledgedAt: now,
            extraFilesAcknowledgedById: 'author',
        });
        expect(repository.rows[0].state).toBe('awaiting_approval');
    });

    it('refuses the acknowledgement for a non-author, with no extra files, or outside the approval window', async () => {
        const extra = { files: 3, additions: 10, deletions: 1, extraFiles: ['CHANGELOG.md'] };
        await expect(
            recordWith({
                state: 'awaiting_approval',
                diffStats: extra,
            }).records.acknowledgeExtraFiles('w1', 'r1', 'editor'),
        ).resolves.toMatchObject({ httpStatus: 403, code: 'authorRequired' });
        await expect(
            recordWith({
                state: 'awaiting_approval',
                diffStats: { ...extra, extraFiles: [] },
            }).records.acknowledgeExtraFiles('w1', 'r1', 'author'),
        ).resolves.toMatchObject({ httpStatus: 409, code: 'extraFilesNotPresent' });
        await expect(
            recordWith({ state: 'preparing', diffStats: extra }).records.acknowledgeExtraFiles(
                'w1',
                'r1',
                'author',
            ),
        ).resolves.toMatchObject({ httpStatus: 409, code: 'notAwaitingApproval' });
    });
});

import { WorkHintResolverService } from '../work-hint-resolver.service';
import type { WorkRepository } from '../../database/repositories/work.repository';
import type { Work } from '../../entities/work.entity';

/**
 * `workId` routing for ingested events — the resolver that turns a
 * connector's `workHint` into a real Work.
 *
 * The invariants under test are the three the service promises: always
 * owner-scoped, null is a normal outcome, never throws.
 */

function makeWork(
    id: string,
    opts: {
        userId?: string;
        repo?: { owner: string; name: string };
        externalRefs?: Work['externalRefs'];
    } = {},
): Work {
    return {
        id,
        userId: opts.userId ?? 'user-1',
        externalRefs: opts.externalRefs ?? null,
        getRepoOwner: () => opts.repo?.owner,
        getMainRepo: () => opts.repo?.name,
        getWebsiteRepo: () => undefined,
        getDataRepo: () => undefined,
    } as unknown as Work;
}

function makeService(works: {
    findByUser?: jest.Mock;
    findById?: jest.Mock;
}): WorkHintResolverService {
    return new WorkHintResolverService(works as unknown as WorkRepository);
}

describe('WorkHintResolverService.resolve', () => {
    it('resolves a repo hint through the shared repo matcher', async () => {
        const service = makeService({
            findByUser: jest
                .fn()
                .mockResolvedValue([
                    makeWork('w-other', { repo: { owner: 'acme', name: 'other' } }),
                    makeWork('w-hit', { repo: { owner: 'acme', name: 'site' } }),
                ]),
        });
        await expect(
            service.resolve('user-1', { kind: 'repo', externalId: 'acme/site' }),
        ).resolves.toBe('w-hit');
    });

    it('returns null for a malformed repo hint instead of guessing', async () => {
        const findByUser = jest
            .fn()
            .mockResolvedValue([makeWork('w1', { repo: { owner: 'acme', name: 'site' } })]);
        const service = makeService({ findByUser });
        await expect(service.resolve('user-1', { kind: 'repo', externalId: 'acme' })).resolves.toBe(
            null,
        );
    });

    it('resolves a chat-channel hint from the Work externalRefs claim map', async () => {
        const service = makeService({
            findByUser: jest
                .fn()
                .mockResolvedValue([
                    makeWork('w-noclaim'),
                    makeWork('w-claim', { externalRefs: { 'chat-channel': ['C0123456789'] } }),
                ]),
        });
        await expect(
            service.resolve('user-1', { kind: 'chat-channel', externalId: 'C0123456789' }),
        ).resolves.toBe('w-claim');
    });

    it('matches claims case-insensitively and ignoring surrounding whitespace', async () => {
        const service = makeService({
            findByUser: jest
                .fn()
                .mockResolvedValue([makeWork('w1', { externalRefs: { 'tracker-team': ['ENG'] } })]),
        });
        await expect(
            service.resolve('user-1', { kind: 'tracker-team', externalId: '  eng  ' }),
        ).resolves.toBe('w1');
    });

    it('resolves doc-database and meeting kinds off the same map', async () => {
        const service = makeService({
            findByUser: jest
                .fn()
                .mockResolvedValue([
                    makeWork('w-db', { externalRefs: { 'doc-database': ['db-1'] } }),
                    makeWork('w-meet', { externalRefs: { meeting: ['888'] } }),
                ]),
        });
        await expect(
            service.resolve('user-1', { kind: 'doc-database', externalId: 'db-1' }),
        ).resolves.toBe('w-db');
        await expect(
            service.resolve('user-1', { kind: 'meeting', externalId: '888' }),
        ).resolves.toBe('w-meet');
    });

    it('returns null when no Work claims the container', async () => {
        const service = makeService({
            findByUser: jest
                .fn()
                .mockResolvedValue([
                    makeWork('w1', { externalRefs: { 'chat-channel': ['CAAA'] } }),
                ]),
        });
        await expect(
            service.resolve('user-1', { kind: 'chat-channel', externalId: 'CBBB' }),
        ).resolves.toBeNull();
    });

    it('never queries at all for an absent, empty or non-object hint', async () => {
        const findByUser = jest.fn();
        const service = makeService({ findByUser });
        await expect(service.resolve('user-1', undefined)).resolves.toBeNull();
        await expect(service.resolve('user-1', null)).resolves.toBeNull();
        await expect(
            service.resolve('user-1', { kind: 'chat-channel', externalId: '   ' }),
        ).resolves.toBeNull();
        expect(findByUser).not.toHaveBeenCalled();
    });

    it('scopes the lookup to the ingesting user — never a global scan', async () => {
        const findByUser = jest.fn().mockResolvedValue([]);
        const service = makeService({ findByUser });
        await service.resolve('user-42', { kind: 'chat-channel', externalId: 'C1' });
        expect(findByUser).toHaveBeenCalledWith('user-42');
    });

    it('degrades to null (never throws) when the Work lookup fails', async () => {
        const service = makeService({
            findByUser: jest.fn().mockRejectedValue(new Error('db down')),
        });
        await expect(
            service.resolve('user-1', { kind: 'chat-channel', externalId: 'C1' }),
        ).resolves.toBeNull();
    });

    it('tolerates a hand-edited claim map holding non-strings', async () => {
        const service = makeService({
            findByUser: jest.fn().mockResolvedValue([
                makeWork('w1', {
                    externalRefs: { 'chat-channel': [42 as unknown as string, 'C1'] },
                }),
            ]),
        });
        await expect(
            service.resolve('user-1', { kind: 'chat-channel', externalId: 'C1' }),
        ).resolves.toBe('w1');
    });
});

describe('WorkHintResolverService.verifyOwnedWorkId', () => {
    it('keeps a workId the ingesting user owns', async () => {
        const service = makeService({
            findById: jest.fn().mockResolvedValue(makeWork('w1', { userId: 'user-1' })),
        });
        await expect(service.verifyOwnedWorkId('user-1', 'w1')).resolves.toBe('w1');
    });

    it('drops a workId belonging to another user (cross-tenant event injection)', async () => {
        const service = makeService({
            findById: jest.fn().mockResolvedValue(makeWork('w1', { userId: 'someone-else' })),
        });
        await expect(service.verifyOwnedWorkId('user-1', 'w1')).resolves.toBeNull();
    });

    it('drops a workId that does not exist', async () => {
        const service = makeService({ findById: jest.fn().mockResolvedValue(null) });
        await expect(service.verifyOwnedWorkId('user-1', 'ghost')).resolves.toBeNull();
    });

    /**
     * This assertion is the inverse of the one it replaces, deliberately.
     *
     * The old contract ("fail open on infrastructure") let a transient
     * `findById` fault carry a caller-chosen `workId` through unverified,
     * so a database blip was enough for an authenticated user to stamp
     * another tenant's Work onto their own ingested events — and the
     * Activity + Memory fan-out keyed off `event.workId` followed it. An
     * ownership check is an identity check; identity checks fail closed.
     * Unrouted is recoverable, cross-tenant is not.
     */
    it('fails CLOSED on an infrastructure error — an unverified workId never survives', async () => {
        const service = makeService({
            findById: jest.fn().mockRejectedValue(new Error('timeout')),
        });
        await expect(service.verifyOwnedWorkId('user-1', 'w1')).resolves.toBeNull();
    });
});
